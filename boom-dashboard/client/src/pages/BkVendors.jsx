import { useState, useEffect, useMemo, useRef, Fragment } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Loader, AlertCircle, ArrowLeft, CheckCircle, Mail, Search, XCircle, LayoutList, LayoutGrid, ChevronRight, AlertTriangle, RefreshCw, Pencil, Check, X, Upload, Package, Zap, FileText, CreditCard } from 'lucide-react'
import Breadcrumb from '../components/Breadcrumb'
import FilePreview from '../components/FilePreview'
import BankEvidenceDot from '../components/BankEvidenceDot'
import ListSearch, { matchesQuery } from '../components/ListSearch'
// The shared answer to "does this row have a file, and where is it" — the same
// pickDoc/fileUrl the Ledger, Reports and the review decks use.
import { pickDoc, fileUrl } from '../utils/entryFiles'
// The one picker for "which invoice(s) did this payment settle" — shared with
// Bank Matching, which posts to the same /attach endpoint.
import InvoiceAttachPicker from '../components/InvoiceAttachPicker'
// toUsd, so an invoice and a bank line are compared in the same currency — with
// the invoice's locked rate when it has one, exactly as the Ledger does it.
import { toUsd, itemsToUsd } from '../utils'
import { useFxRates } from '../context/FxRatesContext'
import SearchableSelect from '../components/SearchableSelect'
import ArtistSelect from '../components/ArtistSelect'
import CategorySelect from '../components/CategorySelect'
import api from '../api'
import getDarkColors from '../utils/darkColors'
import { useTheme } from '../context/ThemeContext'
import { useAuth } from '../context/AuthContext'
import VendorDupeDeck from '../components/VendorDupeDeck'

const RED = '#334155'

function fmt(v, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(v || 0)
}

function fmtDate(d) {
  if (!d) return '—'
  return String(d).slice(0, 10)
}

const SORT_OPTIONS = ['Spent: high', 'Spent: low', 'Name A-Z', 'Name Z-A', 'Most invoices', 'Recent first']
const W9_FILTER = ['All', 'W9 on file', 'Missing W9', 'Name Mismatch']

// Shared badge palette — mirrors BkPayments so a Paid pill on the
// vendor page looks identical to one on the Payment Dashboard.
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

export default function BkVendors() {
  const { vendorName: urlVendorName } = useParams()
  const navigate = useNavigate()
  const { theme } = useTheme()
  const { user } = useAuth()
  // Bank data is statement-derived — Admin/Superadmin only (Approver has
  // full bookkeeping but statements are excluded by policy).
  const canSeeBank = user && (user.role === 'Admin' || user.role === 'Superadmin')
  // Editing a ledger entry is bookkeeping, not bank access — Approvers have full
  // bookkeeping, and this mirrors isBkAdmin on the server so the page never
  // offers a control the endpoint will refuse.
  const canEditEntries = user && ['Admin', 'Superadmin', 'Approver'].includes(user.role)
  const { rates: fxRates } = useFxRates()
  const [bankAct, setBankAct] = useState(null)
  // Invoice filter for the open vendor. Reset on vendor change (below) so a
  // query typed on one vendor doesn't hide another vendor's invoices.
  const [invQ, setInvQ] = useState('')
  const C = getDarkColors(theme)
  // The "entered here, not submitted by the vendor" hue, defined ONCE.
  //
  // It was written out at three sites — the row ground, the row's left edge, and
  // the legend swatch that explains them. Deepened on John's ask (2026-08-18),
  // and the previous version was already the shape of a future bug: change two of
  // three and the legend starts describing a colour the rows no longer use.
  //
  // Still slate. Provenance is not an alert, and this table has had an amber-wall
  // problem before — the point is "look twice", not "something is wrong".
  const ADDED_GROUND = C.isDark ? '#242b3d' : '#e7ebf6'
  const ADDED_EDGE = C.isDark ? '#7c8aa3' : '#8f9ab4'
  const TH = { background: C.thBg, color: C.thText, fontSize: 10, fontWeight: 800, letterSpacing: '0.07em', textTransform: 'uppercase', padding: '10px 12px', textAlign: 'left', borderBottom: '1px solid ' + C.thBorder, whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 1 }
  const TD = { padding: '10px 12px', verticalAlign: 'middle', borderBottom: '1px solid ' + C.tdBorder, fontSize: 13 }
  const inputSty = { background: C.inputBg, border: '1.5px solid ' + C.inputBorder, borderRadius: 8, padding: '8px 12px 8px 36px', color: C.text, fontSize: 13, fontFamily: 'inherit', outline: 'none', width: 280 }
  const selectSty = { background: C.inputBg, border: '1.5px solid ' + C.inputBorder, borderRadius: 8, padding: '8px 12px', color: C.text, fontSize: 13, fontFamily: 'inherit', outline: 'none', cursor: 'pointer', appearance: 'none', backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center', paddingRight: 28 }
  const toolbarBtn = { background: 'none', border: '1.5px solid ' + C.border, color: C.textMuted, padding: '8px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' }
  const W9_YES = { background: C.badgeYesBg, color: C.badgeYesText, padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }
  const W9_NO = { background: C.badgeNoBg, color: C.badgeNoText, padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }
  const [vendors, setVendors] = useState([])
  const [vendorDetail, setVendorDetail] = useState(null)
  // Which pane of the vendor detail is showing. Defaults to Invoices: the page
  // is opened to look at a vendor's invoices, never to edit their aliases.
  const [vendorTab, setVendorTab] = useState('activity')
  // Which sections of the Activity pane are folded.
  //
  // All open by default — John's point was that he wanted to SEE bank and
  // PayPal activity, so nothing starts hidden. Folding is for the vendor where
  // one group is noise: 5 identical salary transfers you have already read, or
  // a PayPal section that is empty.
  //
  // Persisted, because a fold you have to redo on every vendor is not a
  // preference, it is a chore. One key for the page, not per vendor: "I don't
  // care about PayPal right now" is a mood, not a fact about a vendor.
  const FOLD_KEY = 'bk_vendor_folded'
  const [folded, setFolded] = useState(() => {
    try { return JSON.parse(localStorage.getItem(FOLD_KEY) || '{}') } catch { return {} }
  })
  const toggleFold = (key) => setFolded((prev) => {
    const next = { ...prev, [key]: !prev[key] }
    try { localStorage.setItem(FOLD_KEY, JSON.stringify(next)) } catch { /* private mode */ }
    return next
  })


  // Which bank line has its invoice picker open, and whether a write is running.
  const [attachFor, setAttachFor] = useState(null) // txn id
  const [attachBusy, setAttachBusy] = useState(false)
  const [attachErr, setAttachErr] = useState('')

  // Splitting one payment across artists / categories. Same endpoint and same
  // shape as the review deck's split editor — a payment covering two artists is
  // the common case, and answering it here means not leaving the vendor.
  const [splitFor, setSplitFor] = useState(null)      // txn id
  const [splitParts, setSplitParts] = useState([])    // [{amount, category, artist}]
  // ArtistSelect renders a stored spelling the roster doesn't know, so an
  // unusual name on an existing row is never blanked by the dropdown.
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

  // Bank Activity for the open vendor (statement-derived, admin-only)
  useEffect(() => {
    setBankAct(null)
    setInvQ('')
    setAttachFor(null)
    setAttachErr('')
    const payee = vendorDetail?.payee
    if (!payee || !canSeeBank) return
    let cancelled = false
    api.get(`/statements/vendors/activity?ledger=${encodeURIComponent(payee)}`)
      .then((res) => {
        if (cancelled) return
        setBankAct(res.data.data)
        // ?attach=<txnId> — Reports links here when a drill row has no invoice
        // behind it, so "fix it where you spotted it" lands on THIS payment's
        // picker rather than on a page of 100 lines to hunt through. Only opens
        // a line that is actually attachable; a stale link should do nothing
        // rather than open a picker on a row that cannot take one.
        const want = parseInt(new URLSearchParams(window.location.search).get('attach'), 10)
        if (!Number.isFinite(want)) return
        const row = (res.data.data?.transactions || []).find((t) => t.id === want)
        if (row && (row.status === 'open' || row.status === 'booked')) setAttachFor(want)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [vendorDetail?.payee, canSeeBank]) // eslint-disable-line react-hooks/exhaustive-deps
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState('')

  const [search, setSearch] = useState('')
  const [previewFile, setPreviewFile] = useState(null)
  const [sortBy, setSortBy] = useState('Spent: high')
  // Duplicate suggestions, for the review deck. Fetched here because this is
  // where duplicates get NOTICED — the three-rows-are-one-person moment happens
  // reading the directory, not on a separate flags page.
  const [dupes, setDupes] = useState([])
  const [deckOpen, setDeckOpen] = useState(false)
  const [w9Filter, setW9Filter] = useState('All')
  const [view, setView] = useState('table')
  const [scanning, setScanning] = useState(false)
  const [scanResult, setScanResult] = useState(null)
  const [editingVendor, setEditingVendor] = useState(null)
  const [editName, setEditName] = useState('')
  const [savingRename, setSavingRename] = useState(false)
  const [showMerge, setShowMerge] = useState(null) // vendor name to merge FROM
  const [mergeTarget, setMergeTarget] = useState('')
  const [aliases, setAliases] = useState([])
  const [newAlias, setNewAlias] = useState('')
  const [vendorEmails, setVendorEmails] = useState([])
  // Stored payment details. Not fetched with the page: this is the one route in
  // the app that decrypts an account number, and it writes an audit row per read,
  // so it is pulled ONLY when somebody deliberately asks.
  const [payDetails, setPayDetails] = useState(null)
  const [payLoading, setPayLoading] = useState(false)
  const [payErr, setPayErr] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [newEmailLabel, setNewEmailLabel] = useState('')
  const [expandedSplits, setExpandedSplits] = useState(new Set())
  // Multi-select merge from the list view — check 2+ vendors, pick which
  // name survives, and every other selection merges into it (invoices
  // reassigned, old names auto-added as aliases, saved emails carried).
  const [mergeSelection, setMergeSelection] = useState(new Set())
  const [bulkMergeOpen, setBulkMergeOpen] = useState(false)
  const [bulkMergeTarget, setBulkMergeTarget] = useState('')
  const [bulkMerging, setBulkMerging] = useState(false)

  const fetchVendors = async () => {
    try {
      setLoading(true)
      setError('')
      const res = await api.get('/bk/vendors')
      setVendors(res.data.data || [])
    } catch (err) {
      setError('Failed to load vendors: ' + (err.response?.data?.error || err.message))
    } finally {
      setLoading(false)
    }
  }

  const fetchVendorDetail = async (payee, skipNav) => {
    try {
      setDetailLoading(true)
      setError('')
      const res = await api.get(`/bk/vendors/${encodeURIComponent(payee)}`)
      setVendorDetail(res.data.data)
      if (!skipNav) navigate(`/bk/vendors/${encodeURIComponent(payee)}`)
      fetchAliases(payee)
      fetchVendorEmails(payee)
      fetchMerges(payee)
    } catch (err) {
      setError('Failed to load vendor details: ' + (err.response?.data?.error || err.message))
    } finally {
      setDetailLoading(false)
    }
  }

  // ── Ledger matching, on the vendor's own page ────────────────────────────────
  //
  // Every write here is an EXISTING statements endpoint. Nothing new is invented:
  // the same calls the review deck makes, so a pairing recorded from a vendor page
  // is indistinguishable from one recorded on Bank Matching, and both are undoable
  // the same way.
  //
  // Both sides are re-fetched after every write rather than patched in place. A
  // pairing changes the bank list AND the invoice list, and a locally-mutated row
  // is how a control starts offering what the server has already refused.
  const refreshMatching = async () => {
    const payee = vendorDetail?.payee
    if (!payee) return
    await fetchVendorDetail(payee, true)
    if (canSeeBank) {
      await api.get(`/statements/vendors/activity?ledger=${encodeURIComponent(payee)}`)
        .then((res) => setBankAct(res.data.data))
        .catch(() => {})
    }
  }

  // Attach an invoice to a bank line.
  //
  // WHICH call depends on the line's state, and that is not interchangeable:
  //   booked — the app invented a ledger entry for this line, so /rematch deletes
  //            that entry and links the real invoice in its place.
  //   open   — nothing is booked, so /match simply links it.
  // Using /match on a booked row is refused by the server ("booked as its own
  // ledger entry"), which is the guard rail, not the plan.
  // The prepayment refusal, held with enough context to be overridden.
  //
  // The server has always accepted allow_prepayment — a retainer or an advance is
  // the one legitimate way money leaves before an invoice is dated. The client
  // printed the refusal and stopped there, so a correct pairing was unreachable
  // and the sentence explaining WHY read as a verdict rather than a question.
  //
  // Deliberately not a checkbox on the picker: the refusal carries the day gap and
  // the invoice's own date, and the decision should be made against those rather
  // than armed in advance for every attach.
  const [prepayFor, setPrepayFor] = useState(null)  // { retry, detail }

  const attachInvoices = async (txn, invoiceIds, opts = {}) => {
    if (attachBusy || !invoiceIds.length) return
    setAttachBusy(true)
    setAttachErr('')
    if (!opts.allowPrepayment) setPrepayFor(null)
    try {
      // ONE endpoint for one invoice or five. It picks match-or-rematch from the
      // row's own state — a booked row's invented entry has to be displaced in
      // the same transaction, which is why this isn't just "insert some links".
      await api.post(`/statements/tx/${txn.id}/attach`, {
        expense_ids: invoiceIds,
        ...(opts.allowPrepayment ? { allow_prepayment: true } : {}),
      })
      setAttachFor(null)
      setPrepayFor(null)
      await refreshMatching()
    } catch (err) {
      // 409 means another bank row already settles one of them — one invoice is
      // settled by one payment. The server's sentence names the other row.
      const d = err.response?.data
      setAttachErr(d?.error || err.message)
      // A refusal the caller is allowed to overrule comes back marked, with the
      // dates that justify it. Anything else stays a plain refusal.
      setPrepayFor(d?.prepayment_possible
        ? { detail: d.prepayment || {}, retry: () => attachInvoices(txn, invoiceIds, { allowPrepayment: true }) }
        : null)
    } finally { setAttachBusy(false) }
  }

  // Undo an attach, however many invoices it covered. The inverse depends on how
  // the row got here — a row whose booking was displaced goes back to BOOKED, not
  // to open — and the server decides that, not the client.
  // ── FLAG FOR REVIEW ────────────────────────────────────────────────────────
  //
  // John asked for this on vendor pages. Every piece already existed except the
  // control: POST /bk/entries/:id/flag (any bookkeeping user, optional reason),
  // POST /statements/tx/:id/flag (admin), and routes/flags.js already lists both
  // kinds — so a flag raised here lands on /flags rather than nowhere.
  //
  // TWO ENDPOINTS because they are two different records: an invoice in the
  // ledger, and a line on a bank statement. Only `expenses` has a flag_reason
  // column, so a note is offered on invoices and not on bank rows — better than
  // pretending to store one.
  const [flagBusy, setFlagBusy] = useState(null)
  const [flagNoteFor, setFlagNoteFor] = useState(null)
  const [flagNote, setFlagNote] = useState('')
  const toggleFlag = async (kind, row, reason = null) => {
    if (flagBusy) return
    setFlagBusy(`${kind}:${row.id}`)
    setAttachErr('')
    try {
      const on = !row.flagged
      if (kind === 'inv') {
        await api.post(`/bk/entries/${row.id}/flag`, { flagged: on, flag_reason: on ? reason : null })
      } else {
        await api.post(`/statements/tx/${row.id}/flag`, { flag: on })
      }
      setArtistNote(on
        ? 'Flagged for review — it will show on the Flags page until somebody clears it.'
        : 'Flag cleared.')
      // Offer the note only when RAISING a flag on an invoice, and only after the
      // flag is safely saved: the reason is a nicety, the flag is the point.
      if (on && kind === 'inv' && !reason) { setFlagNoteFor(row.id); setFlagNote('') }
      else { setFlagNoteFor(null) }
      await refreshMatching()
      await fetchVendorDetail(vendorDetail?.payee || urlVendorName, true)
    } catch (err) {
      setAttachErr(err.response?.data?.error || err.message)
    } finally { setFlagBusy(null) }
  }
  // A saved note re-posts with flagged:true, which is idempotent on the server.
  const saveFlagNote = async (row) => {
    const note = flagNote.trim()
    setFlagNoteFor(null)
    if (!note) return
    try {
      await api.post(`/bk/entries/${row.id}/flag`, { flagged: true, flag_reason: note })
      setArtistNote('Flag note saved.')
      await fetchVendorDetail(vendorDetail?.payee || urlVendorName, true)
    } catch (err) { setAttachErr(err.response?.data?.error || err.message) }
  }
  // One control, both tables. Rose because a raised flag IS an alert — it is the
  // one state on this page that asks somebody else to look.
  const flagButton = (kind, row) => {
    const busy = flagBusy === `${kind}:${row.id}`
    const who = row.flagged_by_name || row.flagged_by
    return (
      <button onClick={(e) => { e.stopPropagation(); toggleFlag(kind, row) }} disabled={!!flagBusy}
        title={row.flagged
          ? `Flagged for review${who ? ` by ${who}` : ''}${row.flag_reason ? ` — "${row.flag_reason}"` : ''}. Click to clear.`
          : 'Flag this for review. It shows on the Flags page until somebody clears it.'}
        style={{ background: 'none', border: 'none', padding: '0 2px', cursor: flagBusy ? 'default' : 'pointer',
          color: row.flagged ? '#e11d48' : C.textFaint, fontSize: 11, fontWeight: 800,
          fontFamily: 'inherit', flexShrink: 0, opacity: busy ? 0.4 : 1, lineHeight: 1 }}>
        {row.flagged ? '\u2691' : '\u2690'}
      </button>
    )
  }

  const unattachLine = async (txn) => {
    if (attachBusy) return
    setAttachBusy(true)
    setAttachErr('')
    try {
      await api.post(`/statements/tx/${txn.id}/unattach`)
      await refreshMatching()
    } catch (err) {
      setAttachErr(err.response?.data?.error || err.message)
    } finally { setAttachBusy(false) }
  }

  // Book one payment as several ledger entries, each with its own category and
  // artist. Accepted on BOOKED rows too: the entry the app invented is displaced
  // inside the same transaction, so the money is never on the books twice.
  const bookSplit = async (txn) => {
    if (attachBusy) return
    const parts = splitParts
      .map((p) => ({ amount: Number(p.amount), category: p.category, artist: p.artist || null }))
      .filter((p) => p.amount > 0 && p.category)
    const sum = parts.reduce((s, p) => s + p.amount, 0)
    // Refused server-side too; checked here so the answer is instant rather than
    // a round trip to be told the arithmetic doesn't work.
    if (parts.length < 2 || Math.abs(sum - Number(txn.amount)) > 0.01) {
      setAttachErr(`The parts total ${fmt(sum)} but the payment is ${fmt(Number(txn.amount))}.`)
      return
    }
    setAttachBusy(true)
    setAttachErr('')
    try {
      await api.post(`/statements/tx/${txn.id}/split-book`, { parts })
      setSplitFor(null)
      setSplitParts([])
      await refreshMatching()
    } catch (err) {
      setAttachErr(err.response?.data?.error || err.message)
    } finally { setAttachBusy(false) }
  }

  // Editing an entry's category / artist / song without leaving the vendor.
  //
  // This page is where you look at ONE vendor's whole history, which is exactly
  // when a wrong artist or a missing song is obvious — and until now the answer
  // was "go to the Ledger, search for it, fix it there". Same endpoint the
  // Ledger's own inline edit uses, so the rules (auto-link to a release, the
  // song-comma split) are the ledger's, not a second copy.
  const [editCell, setEditCell] = useState(null)   // `${id}:${field}`
  const [editVal, setEditVal] = useState('')
  const [editBusy, setEditBusy] = useState(false)
  const saveEntryField = async (row, field, value) => {
    const before = (row[field] ?? '')
    const next = value == null ? '' : String(value)
    setEditCell(null)
    // A no-op write still costs a refetch and an audit line.
    if (String(before).trim() === next.trim()) return
    setEditBusy(true)
    setAttachErr('')
    try {
      await api.put(`/bk/entries/${row.id}`, { [field]: next.trim() || null })
      // Refetch rather than patch in place: the server may split on a comma'd
      // song or auto-link a release, and a patched row would hide that.
      await fetchVendorDetail(vendorDetail?.payee || urlVendorName, true)
    } catch (err) {
      setAttachErr(err.response?.data?.error || err.message)
    } finally { setEditBusy(false) }
  }

  // The category of the entry behind a BANK ROW, edited from the bank list.
  //
  // Same write as the invoice table's inline edit (PUT /bk/entries/:id), but it
  // has to refetch BOTH halves: the category is displayed on the bank row AND on
  // the entry in the table above, and refreshing one would leave the two showing
  // different categories for the same payment.
  const [rowCatFor, setRowCatFor] = useState(null)   // txn id being edited
  const saveRowCategory = async (row, value) => {
    setRowCatFor(null)
    if (!row.matched_expense_id || !value || value === row.matched_category) return
    setEditBusy(true)
    setAttachErr('')
    try {
      await api.put(`/bk/entries/${row.matched_expense_id}`, { category: value })
      await refreshMatching()
    } catch (err) {
      setAttachErr(err.response?.data?.error || err.message)
    } finally { setEditBusy(false) }
  }

  // The artist on the entry behind a bank row, set from the bank list.
  //
  // Same write as the selection-scoped attribution (/reports/set-artist) and the
  // Reports drill — no rule, this row only. Refetches both halves because the
  // artist shows on the bank row AND on the entry in the table above.
  const [rowArtistFor, setRowArtistFor] = useState(null)
  const saveRowArtist = async (row, value) => {
    setRowArtistFor(null)
    if (!row.matched_expense_id) return
    const name = String(value || '').trim()
    if (name === String(row.artist || '').trim()) return
    setEditBusy(true)
    setAttachErr('')
    try {
      await api.post('/reports/set-artist', { expense_ids: [row.matched_expense_id], artist: name })
      await refreshMatching()
    } catch (err) {
      setAttachErr(err.response?.data?.error || err.message)
    } finally { setEditBusy(false) }
  }

  // ── Answering an OPEN row ────────────────────────────────────────────────
  //
  // An open bank line has NO ledger entry, so there is nothing for the artist and
  // category controls above to write onto — both of them guard on
  // `matched_expense_id` and render nothing, which is why John's $100 line on
  // 2026-06-24 sat between four booked rows offering both answers and could be
  // given neither.
  //
  // Answering it has to CREATE the entry. Same call and the same ordering Bank
  // Matching uses: the artist is held here and the category commits. A control
  // offered after booking asks at the exact moment people move on, which is how
  // thousands of booked rows ended up naming nobody.
  const [openArtist, setOpenArtist] = useState({})   // txn id -> artist, not yet written
  const bookOpenRow = async (row, category) => {
    if (editBusy || !category) return
    setEditBusy(true)
    setAttachErr('')
    try {
      // Blank is left OUT rather than sent empty, so bookDebitAsEntry can still
      // fall back to the vendor's standing artist answer instead of being handed
      // an empty string that overrides it.
      const artist = String(openArtist[row.id] || '').trim()
      // No `confirm_new`: the 409 speed bump is the point on this page of all
      // places. This is where a $200 payment was booked a second time over an
      // invoice that already existed, and "attach invoice" sits one control to
      // the right. The refusal names the invoice it found.
      await api.post(`/statements/tx/${row.id}/create-entry`, { category, ...(artist ? { artist } : {}) })
      setOpenArtist((p) => { const n = { ...p }; delete n[row.id]; return n })
      await refreshMatching()
    } catch (err) {
      setAttachErr(err.response?.data?.error || err.message)
    } finally { setEditBusy(false) }
  }

  // The merges this vendor is made of, so a merge can be undone later than the
  // seconds after making it. Deleting the alias in "Also known as" removes the
  // only visible trace while leaving the merge in place — the entries stay
  // renamed — which is how a vendor disappears entirely.
  const [merges, setMerges] = useState([])
  const fetchMerges = async (payee) => {
    if (!payee || !canEditEntries) return
    try {
      const { data } = await api.get(`/bk/vendors/merges?vendor=${encodeURIComponent(payee)}`)
      setMerges(data?.data?.merges || [])
    } catch { setMerges([]) }
  }
  const [mergeBusy, setMergeBusy] = useState(false)
  const unmergeVendor = async (m) => {
    if (mergeBusy) return
    if (!window.confirm(`Undo the merge of "${m.source}" into "${m.target}"?\n\n`
      + `${m.entries} entr${m.entries === 1 ? 'y' : 'ies'} go back to "${m.source}"`
      + (m.bank_links ? `, and ${m.bank_links} bank link${m.bank_links === 1 ? '' : 's'} with them` : '')
      + `.\n\nRows that were always "${m.target}" are NOT touched — this reverses by id, not by name.`)) return
    setMergeBusy(true)
    setError('')
    try {
      const { data } = await api.post(`/bk/vendors/unmerge/${m.id}`)
      setArtistNote(`"${m.source}" is a vendor again — ${data?.data?.restored ?? m.entries} entries moved back to it.`)
      await fetchVendorDetail(vendorDetail?.payee || urlVendorName, true)
      await fetchMerges(vendorDetail?.payee || urlVendorName)
    } catch (err) {
      setError('Unmerge failed: ' + (err.response?.data?.error || err.message))
    } finally { setMergeBusy(false) }
  }

  // Detach a selection from its invoices, and the other undo beside it. Both
  // exist here because the vendor page is where you see a vendor's matches
  // together and notice that one of them is wrong.
  const bulkUnmatch = async (ids) => {
    if (attachBusy || !ids.length) return
    if (!window.confirm(`Unmatch ${ids.length} payment${ids.length === 1 ? '' : 's'} from their invoices?\n\n`
      + 'Those invoices go back to waiting for a bank line. A row that displaced a booking when it was '
      + 'matched gets that booking back.')) return
    setAttachBusy(true)
    setAttachErr('')
    try {
      const { data } = await api.post('/statements/unmatch/bulk', { txn_ids: ids })
      const d = data?.data || {}
      setLineSel(new Set())
      setInvSel(new Set())
      setArtistNote(`${d.done} unmatched`
        + (d.restored?.length ? ` · ${d.restored.length} went back to booked, with the entry the attach had displaced` : '')
        + (d.skipped?.length ? ` · ${d.skipped.length} skipped (${d.skipped[0]?.reason})` : '') + '.')
      await refreshMatching()
    } catch (err) {
      setAttachErr(err.response?.data?.error || err.message)
    } finally { setAttachBusy(false) }
  }
  const bulkUnbookLines = async (ids) => {
    if (attachBusy || !ids.length) return
    if (!window.confirm(`Unbook ${ids.length} payment${ids.length === 1 ? '' : 's'}?\n\n`
      + 'The entry the app invented for each one is removed and the row reopens.')) return
    setAttachBusy(true)
    setAttachErr('')
    let done = 0
    try {
      for (const id of ids) { await api.post(`/statements/tx/${id}/unbook`); done += 1 }
      setLineSel(new Set())
      setArtistNote(`${done} unbooked — those rows are open again.`)
      await refreshMatching()
    } catch (err) {
      setAttachErr(`${done} of ${ids.length} unbooked, then: ` + (err.response?.data?.error || err.message))
      await refreshMatching()
    } finally { setAttachBusy(false) }
  }

  // Unmatch an INVOICE from the bank line settling it, read off the evidence the
  // row already carries. The vendor page lists invoices and bank lines in two
  // places; before this, the undo lived only on the bank line, so spotting a
  // wrong match while reading the invoice table meant going to find its row.
  const [invSel, setInvSel] = useState(() => new Set())
  // ── BULK ACTIONS ON THE SELECTED INVOICES ──────────────────────────────────
  //
  // John asked to recategorize and flag several at once. Both loop the SAME
  // single-row endpoints the inline editors already use — PUT /bk/entries/:id and
  // POST /bk/entries/:id/flag — rather than gaining bulk routes of their own. A
  // second implementation of "change a category" is how two paths end up
  // disagreeing about what that means, and these are small sets (this table caps
  // at the vendor's own invoices).
  //
  // Failures are COLLECTED, not thrown: one refusal must not abandon the rest,
  // and the count of what actually changed is what gets reported.
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkNote, setBulkNote] = useState('')
  const runBulk = async (rows, label, fn) => {
    if (bulkBusy || !rows.length) return
    setBulkBusy(true)
    setBulkNote('')
    setAttachErr('')
    let done = 0
    const failed = []
    for (const r of rows) {
      try { await fn(r); done += 1 } catch (err) {
        failed.push(`${r.invoice_number || r.id}: ${err.response?.data?.error || err.message}`)
      }
    }
    setBulkNote(`${done} ${label}${failed.length ? ` · ${failed.length} refused` : ''}`)
    if (failed.length) setAttachErr(failed.slice(0, 3).join(' · '))
    await fetchVendorDetail(vendorDetail?.payee || urlVendorName, true)
    await refreshMatching()
    setBulkBusy(false)
  }
  const bulkSetCategory = (rows, category) => runBulk(
    // Rows already on that category are skipped — "12 recategorized" should mean
    // twelve rows changed, not twelve requests sent.
    rows.filter((r) => (r.category || '') !== category),
    `recategorized to ${category}`,
    (r) => api.put(`/bk/entries/${r.id}`, { category }),
  )
  const bulkFlag = (rows, on) => runBulk(
    rows.filter((r) => !!r.flagged !== on),
    on ? 'flagged' : 'cleared',
    (r) => api.post(`/bk/entries/${r.id}/flag`, { flagged: on }),
  )

  const unmatchInvoice = async (inv) => {
    const txnId = inv?.bank_evidence?.txn_id
    if (!txnId || attachBusy) return
    if (!window.confirm(`Unmatch ${inv.invoice_number ? `invoice ${inv.invoice_number}` : `entry #${inv.id}`} `
      + `from the ${fmtDate(inv.bank_evidence.txn_date)} bank line?\n\n`
      + 'The invoice goes back to waiting for a bank line, and that payment returns to the queue.')) return
    setAttachBusy(true)
    setAttachErr('')
    try {
      await api.post(`/statements/tx/${txnId}/unattach`)
      await refreshMatching()
    } catch (err) {
      setAttachErr(err.response?.data?.error || err.message)
    } finally { setAttachBusy(false) }
  }

  // TWO PAYMENTS, ONE INVOICE. The mirror of the picker's own case, and the one
  // an instalment creates: a deposit and a balance settle a single invoice, and
  // until now the second payment could only be matched to something else or
  // left looking unexplained.
  //
  // Posted one payment at a time through the SAME /attach the single case uses,
  // so every guard runs per payment — the prepayment check, the bank-created
  // refusal, and the overpay test that now decides whether one more payment
  // fits. If the third would overpay, it says so and the first two stand.
  const [multiFor, setMultiFor] = useState(null)   // txn ids being attached together
  const attachManyToOne = async (txnIds, invoiceId, opts = {}) => {
    if (attachBusy || !txnIds.length) return
    setAttachBusy(true)
    setAttachErr('')
    if (!opts.allowPrepayment) setPrepayFor(null)
    let done = 0
    try {
      for (const id of txnIds) {
        await api.post(`/statements/tx/${id}/attach`, {
          expense_ids: [invoiceId],
          ...(opts.allowPrepayment ? { allow_prepayment: true } : {}),
        })
        done += 1
      }
      setMultiFor(null)
      setLineSel(new Set())
      setPrepayFor(null)
      setArtistNote(`${done} payment${done === 1 ? '' : 's'} attached to one invoice.`)
      await refreshMatching()
    } catch (err) {
      // Say how far it got. "Failed" after two of three landed would send
      // someone looking for a problem that is really two-thirds finished.
      const d = err.response?.data
      setAttachErr((done ? `${done} of ${txnIds.length} attached, then stopped: ` : '')
        + (d?.error || err.message))
      // Retrying the WHOLE set is safe: the rows already attached are skipped by
      // the overpay guard, so a partial batch is not attached twice.
      setPrepayFor(d?.prepayment_possible
        ? { detail: d.prepayment || {}, retry: () => attachManyToOne(txnIds, invoiceId, { allowPrepayment: true }) }
        : null)
      await refreshMatching()
    } finally { setAttachBusy(false) }
  }

  // Resolve a reversal where you can see it. One call, because dropping the
  // record and dismissing both legs only make sense together — a debit whose
  // entry is gone but which is still live reads as unbooked spend.
  const resolveReversal = async (r) => {
    if (attachBusy) return
    const backed = r.debit.matched_expense_id
    if (!window.confirm(`Resolve this reversal?\n\n${fmt(r.amount)} went out ${fmtDate(r.debit.txn_date)} and came back ${fmtDate(r.credit.txn_date)}.\n\n`
      + (backed
        ? (r.debit.match_method === 'created'
          ? 'The entry booked from the debit is removed (it recorded money that never left), and both legs are dismissed.'
          : 'The invoice is unlinked — it stays on the ledger, it just was not paid by this transfer — and both legs are dismissed.')
        : 'Both legs are dismissed. Nothing is booked against them.')
      + '\n\nReversible from here.')) return
    setAttachBusy(true)
    setAttachErr('')
    try {
      const { data } = await api.post('/statements/reversals/resolve',
        { debit_id: r.debit.id, credit_id: r.credit.id })
      const removed = data?.data?.removed_entry_id
      setArtistNote(`Reversal resolved — ${removed ? `booking ${removed} removed, ` : ''}both legs dismissed.`
        + (removed ? ' Undo restores it.' : ''))
      if (removed) setRevUndo({ ...r, restore_entry_id: removed })
      await refreshMatching()
    } catch (err) {
      setAttachErr(err.response?.data?.error || err.message)
    } finally { setAttachBusy(false) }
  }
  const [revUndo, setRevUndo] = useState(null)
  const undoReversal = async (r) => {
    if (attachBusy) return
    setAttachBusy(true)
    try {
      await api.post('/statements/reversals/resolve',
        { debit_id: r.debit.id, credit_id: r.credit.id, undo: true, restore_entry_id: r.restore_entry_id || null })
      setRevUndo(null)
      setArtistNote('Reversal restored — both legs are back and the booking with them.')
      await refreshMatching()
    } catch (err) {
      setAttachErr(err.response?.data?.error || err.message)
    } finally { setAttachBusy(false) }
  }

  // "Actually, this one does need an invoice." The inverse of markNoInvoice, and
  // the reason it exists: once a line was marked, the vendor page offered no way
  // back — the checkbox and the button both disappeared, so the answer looked
  // permanent from the page where it was given.
  const expectInvoice = async (txn) => {
    if (attachBusy) return
    setAttachBusy(true)
    setAttachErr('')
    try {
      await api.post(`/statements/tx/${txn.id}/no-invoice`, { undo: true })
      await refreshMatching()
    } catch (err) {
      setAttachErr(err.response?.data?.error || err.message)
    } finally { setAttachBusy(false) }
  }
  const bulkExpectInvoice = async (ids) => {
    if (attachBusy || !ids.length) return
    setAttachBusy(true)
    setAttachErr('')
    try {
      for (const id of ids) await api.post(`/statements/tx/${id}/no-invoice`, { undo: true })
      setLineSel(new Set())
      setArtistNote(`${ids.length} line${ids.length === 1 ? '' : 's'} will be asked for an invoice again.`)
      await refreshMatching()
    } catch (err) {
      setAttachErr(err.response?.data?.error || err.message)
    } finally { setAttachBusy(false) }
  }

  // Undo the overhead answer. Deleting the rule is what brings the vendor back
  // into the needs-an-artist queue; nothing was written to the ledger, so there
  // is nothing else to reverse.
  const undoArtistRule = async (rule) => {
    if (artistBusy || !rule?.id) return
    setArtistBusy(true)
    setAttachErr('')
    try {
      await api.delete(`/statements/artist-rules/${rule.id}`)
      setArtistNote(rule.is_overhead
        ? 'No longer marked as overhead — these payments are being asked for an artist again.'
        : `The "${rule.artist}" rule is gone. Artists already written stay on their entries.`)
      await refreshMatching()
    } catch (err) {
      setAttachErr(err.response?.data?.error || err.message)
    } finally { setArtistBusy(false) }
  }

  // Close a PayPal payment against the bank pull that funded it. The ledger entry
  // moves with it server-side — dismissing a leg that holds the only entry would
  // remove the spend from the report rather than relocate it.
  // `bankTxnId` is passed explicitly for a CROSS-CURRENCY proposal, where the
  // pull lives on `funding_proposal` rather than `funding` — the server treats
  // both the same, because confirming a proposal IS the pairing decision.
  const pairFunding = async (ppTxn, undo = false, bankTxnId = null) => {
    const bankId = bankTxnId || ppTxn.funding?.id
    if (attachBusy || !bankId) return
    setAttachBusy(true)
    setAttachErr('')
    try {
      const { data } = await api.post(`/statements/tx/${ppTxn.id}/funding-pair`,
        { bank_txn_id: bankId, undo })
      const d = data?.data || {}
      setArtistNote(undo
        ? `PayPal copy restored${d.entry_moved ? ', and its ledger entry moved back' : ''}.`
          : `Closed against bank statement row #${bankId}`
          + (d.entry_moved ? `, and ledger entry ${d.entry_moved} moved onto it — that row is what the P&L counts.` : '')
          // Say what was carried: the whole point of merging rather than
          // deleting is that an artist set on the bank side survives.
          + (d.entry_removed ? `. The duplicate bank-side entry was removed${d.carried?.length ? ` and its ${d.carried.join(', ')} carried onto the PayPal record` : ''} — this payment now has one record, so attributing it once attributes it everywhere.` : '')
          + (!d.entry_moved && !d.entry_removed ? '.' : ''))
      await refreshMatching()
    } catch (err) {
      setAttachErr(err.response?.data?.error || err.message)
    } finally { setAttachBusy(false) }
  }

  // WHO the spend was for. A booked line has a category we guessed and no artist
  // at all, so it looks finished on every screen while sitting in Spend by
  // Artist's unattributed remainder. Two answers, both reversible from /bk/rules:
  // attribute it, or say this vendor's spend isn't an artist's.
  const [artistPick, setArtistPick] = useState('')
  const [artistBusy, setArtistBusy] = useState(false)
  const [artistNote, setArtistNote] = useState('')

  const answerArtist = async ({ overhead }) => {
    if (artistBusy) return
    const rows = (bankAct?.transactions || []).filter((t) => t.needs_artist)
    if (!rows.length) return
    if (!overhead && !artistPick.trim()) { setAttachErr('Pick an artist first.'); return }
    // Rules match the ledger payee by EQUALITY, so every spelling these rows are
    // booked under needs its own rule — otherwise the answer hides some of the
    // rows and the flag comes back looking broken. Usually that is one name.
    const patterns = [...new Set(rows.map((t) => (t.ledger_payee || '').trim()).filter((n) => n.length >= 3))]
    if (!patterns.length) patterns.push(String(vendorDetail?.payee || urlVendorName || '').trim())
    setArtistBusy(true)
    setAttachErr('')
    setArtistNote('')
    try {
      let updated = 0
      for (const pattern of patterns) {
        const mine = rows.filter((t) => (t.ledger_payee || '').trim() === pattern || patterns.length === 1)
        const { data } = await api.post('/statements/artist-rules', {
          pattern,
          ...(overhead
            ? { is_overhead: true }
            : { artist: artistPick.trim(), entry_ids: mine.map((t) => t.matched_expense_id).filter(Boolean) }),
        })
        updated += Number(data?.data?.updated || 0)
      }
      // Say what actually happened, not what was asked for — a gap means rows
      // moved under us (already attributed, unbooked, deleted).
      setArtistNote(overhead
        ? `Marked as overhead — ${rows.length} line${rows.length === 1 ? '' : 's'} stop being asked about. Reversible from Rules.`
        : `${updated} of ${rows.length} line${rows.length === 1 ? '' : 's'} attributed to ${artistPick.trim()}.`)
      setArtistPick('')
      await refreshMatching()
    } catch (err) {
      setAttachErr(err.response?.data?.error || err.message)
    } finally { setArtistBusy(false) }
  }

  // Attribute JUST the ticked rows, and write no rule.
  //
  // answerArtist below answers for the whole vendor and records a rule so future
  // statements are handled the same way. That is the right answer when a vendor's
  // spend is all one artist's, and the wrong one the moment it isn't: John's case
  // was five booked payments where two are Royalties for one artist and three are
  // Marketing. A vendor-wide rule there would keep mis-attributing everything
  // that arrives next month.
  //
  // /reports/set-artist is the existing write for "these specific entries" —
  // the same one the Reports drill uses, so there is one definition of
  // attributing spend rather than a second that could disagree with it.
  const attributeSelected = async (ids) => {
    if (artistBusy) return
    const name = artistPick.trim()
    if (!name) { setAttachErr('Pick an artist first.'); return }
    const rows = (bankAct?.transactions || []).filter((t) => ids.includes(t.id))
    const entryIds = rows.map((t) => t.matched_expense_id).filter(Boolean)
    if (!entryIds.length) {
      setAttachErr('None of the selected payments has a ledger entry to attribute — book or match them first.')
      return
    }
    setArtistBusy(true)
    setAttachErr('')
    setArtistNote('')
    try {
      await api.post('/reports/set-artist', { expense_ids: entryIds, artist: name })
      // Says how many of the SELECTION landed, not how many were asked for: a
      // ticked row with no entry cannot be attributed and silently counting it
      // would overstate what happened.
      setArtistNote(`${entryIds.length} of ${ids.length} selected payment${ids.length === 1 ? '' : 's'} attributed to ${name}.`
        + (entryIds.length < ids.length ? ` ${ids.length - entryIds.length} had no ledger entry.` : '')
        + ' No rule written — this vendor\'s other payments are untouched.')
      setArtistPick('')
      setLineSel(new Set())
      await refreshMatching()
    } catch (err) {
      setAttachErr(err.response?.data?.error || err.message)
    } finally { setArtistBusy(false) }
  }

  // "No invoice will ever exist for this line" — payroll, a card autopay, rent.
  // The same endpoint and the same meaning as the review deck's N key.
  const markNoInvoice = async (txn) => {
    if (attachBusy) return
    setAttachBusy(true)
    setAttachErr('')
    try {
      await api.post(`/statements/tx/${txn.id}/no-invoice`, {})
      setAttachFor(null)
      await refreshMatching()
    } catch (err) {
      // 409 = an already-paid invoice matches this payment, which is precisely
      // what refutes "no invoice exists for this line". It is a speed bump, not a
      // refusal, so the person gets the choice — the same confirm the review deck
      // shows. Surfacing the raw error instead would end in "re-send with
      // confirm_new", which is an instruction to a developer, not an answer.
      if (err.response?.status === 409) {
        const msg = err.response?.data?.error || 'An already-paid invoice matches this payment.'
        if (window.confirm(`${msg}\n\nOK marks this line as never having an invoice anyway.`)) {
          try {
            await api.post(`/statements/tx/${txn.id}/no-invoice`, { confirm_new: true })
            setAttachFor(null)
            await refreshMatching()
          } catch (e2) { setAttachErr(e2.response?.data?.error || e2.message) }
        }
      } else {
        setAttachErr(err.response?.data?.error || err.message)
      }
    } finally { setAttachBusy(false) }
  }

  // ── Filed under the wrong vendor ────────────────────────────────────────────
  //
  // Two different mistakes with two different fixes, and conflating them is how
  // you lose data:
  //
  //   an INVOICE under the wrong payee → rename that one entry. NOT a merge:
  //     merging says "these two companies are one", which renames every entry of
  //     one into the other and writes an alias. Moving one invoice says nothing
  //     about the vendors.
  //
  //   a BANK LINE on the wrong company → repoint the payee map, which is the
  //     lesson the matcher reads, so every future statement follows it too. That
  //     is why the confirm says it moves EVERY line from that bank payee: the map
  //     is keyed by descriptor, not by row, and pretending otherwise would be a
  //     lie about what the click did.
  const [moveFor, setMoveFor] = useState(null)      // 'inv:<id>' | 'bank:<payee>'
  const [moveQ, setMoveQ] = useState('')
  const [moveOpts, setMoveOpts] = useState([])
  const moveTimer = useRef(null)
  const onMoveQuery = (val) => {
    setMoveQ(val)
    clearTimeout(moveTimer.current)
    if (val.trim().length < 2) { setMoveOpts([]); return }
    moveTimer.current = setTimeout(async () => {
      try {
        const res = await api.get(`/bk/suggest-vendor?q=${encodeURIComponent(val.trim())}`)
        setMoveOpts((res.data.data || []).slice(0, 8))
      } catch { setMoveOpts([]) }
    }, 300)
  }
  const closeMove = () => { setMoveFor(null); setMoveQ(''); setMoveOpts([]) }

  const moveInvoiceTo = async (inv, target) => {
    if (attachBusy || !target) return
    if (!window.confirm(
      `Move ${inv.invoice_number ? `invoice ${inv.invoice_number}` : `entry #${inv.id}`} to "${target}"?\n\n`
      + 'Only this entry moves. Both vendors stay as they are — this is not a merge.')) return
    setAttachBusy(true)
    setAttachErr('')
    try {
      await api.put(`/bk/entries/${inv.id}`, { payee: target })
      closeMove()
      await refreshMatching()
    } catch (err) { setAttachErr(err.response?.data?.error || err.message) }
    finally { setAttachBusy(false) }
  }

  const moveBankPayeeTo = async (bankPayee, target) => {
    if (attachBusy || !target) return
    if (!window.confirm(
      `Move the bank payee "${bankPayee}" to "${target}"?\n\n`
      + 'This repoints the payee map, so EVERY line from that bank descriptor — past and future — '
      + 'belongs to that vendor. Matched and booked rows keep their links; only which company '
      + 'they are filed under changes.')) return
    setAttachBusy(true)
    setAttachErr('')
    try {
      await api.post('/statements/vendors/link', { bank_payee: bankPayee, ledger_payee: target })
      closeMove()
      await refreshMatching()
    } catch (err) { setAttachErr(err.response?.data?.error || err.message) }
    finally { setAttachBusy(false) }
  }

  // ONE line to another vendor.
  //
  // Different operation from moveBankPayeeTo above, and the difference is the
  // whole reason both exist: that one repoints the payee map and moves EVERY
  // line carrying the descriptor, which is right for "all 195 FACEBK charges are
  // Facebook" and wrong for "this single PayPal pull was really the Gersh
  // Agency". This writes an override on the row alone and teaches the matcher
  // nothing, so one odd payment cannot rewrite where a whole descriptor lands.
  const moveBankRowTo = async (row, target, opts = {}) => {
    if (attachBusy || !target) return
    // A matched row moves WITH its invoice — the match is a separate fact from
    // where the payment is filed, and dropping it would silently unsettle an
    // invoice as a side effect of filing. Said out loud when the invoice belongs
    // to a different company, because that combination is either the point (a
    // nameless "PAYPAL" pull whose invoice names the real vendor) or a mistake,
    // and only the person clicking can tell which.
    const invVendor = (row.ledger_payee || '').trim()
    const invNote = row.matched_expense_id
      ? `\n\nIt stays matched to ${row.invoice_number ? `invoice ${row.invoice_number}` : `entry #${row.matched_expense_id}`}`
        + `${invVendor ? `, which is filed under "${invVendor}"` : ''}.`
        + (invVendor && invVendor.toLowerCase() !== target.toLowerCase()
          ? ` That is a different vendor from the one you are moving it to — intended if the bank text names nobody useful, worth a second look otherwise.`
          : '')
      : ''
    if (!window.confirm(
      `Move this ${fmt(row.amount, row.currency)} payment on ${fmtDate(row.txn_date)} to "${target}"?\n\n`
      + `The bank calls it "${row.payee_guess}". Only THIS line moves — every other line from that `
      + `descriptor stays where it is, and the matcher learns nothing from it.`
      + (opts.createNew
        ? `\n\nNo vendor is called "${target}" yet — it comes into existence with this payment. Check the spelling now; a typo becomes a company nobody looks at again.`
        : '')
      + invNote
      + '\n\nReversible from the moved line.')) return
    setAttachBusy(true)
    setAttachErr('')
    try {
      await api.post(`/statements/tx/${row.id}/vendor`,
        { ledger_payee: target, ...(opts.createNew ? { confirm_new: true } : {}) })
      closeMove()
      await refreshMatching()
    } catch (err) { setAttachErr(err.response?.data?.error || err.message) }
    finally { setAttachBusy(false) }
  }

  // The same move, for a selection. A vendor page holds 46, 151, 195 lines, and
  // "these twelve nameless PayPal pulls were all the Gersh Agency" is a single
  // decision — making it twelve clicks is how it does not get made.
  const bulkMoveLines = async (ids, target, opts = {}) => {
    if (attachBusy || !ids.length || !target) return
    const rows = (bankAct?.transactions || []).filter((t) => ids.includes(t.id))
    const withInvoice = rows.filter((t) => t.matched_expense_id)
    if (!window.confirm(
      `Move ${ids.length} payment${ids.length === 1 ? '' : 's'} to "${target}"?\n\n`
      + 'Only these lines move — every other line from their bank descriptors stays where it is, '
      + 'and the matcher learns nothing from it.'
      + (opts.createNew
        ? `\n\nNo vendor is called "${target}" yet — it comes into existence with these payments. Check the spelling now.`
        : '')
      + (withInvoice.length
        ? `\n\n${withInvoice.length} of them stay matched to their invoices; filing a payment and settling an invoice are separate facts.`
        : '')
      + '\n\nReversible per line, from the moved rows.')) return
    setAttachBusy(true)
    setAttachErr('')
    try {
      const res = await api.post('/statements/vendor/bulk',
        { txn_ids: ids, ledger_payee: target, ...(opts.createNew ? { confirm_new: true } : {}) })
      const d = res.data.data
      closeMove()
      setLineSel(new Set())
      // Per-row outcomes are reported, not swallowed. A bulk action that says
      // nothing about what it skipped reads as having done everything.
      if (d.skipped?.length) setAttachErr(`Moved ${d.done}. ${d.skipped.length} skipped: `
        + d.skipped.slice(0, 3).map((x) => `#${x.id} ${x.reason}`).join('; ')
        + (d.skipped.length > 3 ? ' …' : ''))
      await refreshMatching()
    } catch (err) { setAttachErr(err.response?.data?.error || err.message) }
    finally { setAttachBusy(false) }
  }

  // Settle a contested funding pull: file it by hand with the payment that owns it.
  //
  // Two payments of the same amount inside the window both want one bank pull and
  // no descriptor names either, so nothing claims it automatically — handing it to
  // whichever page loaded first is what put one $200 pull on three vendors. A
  // person can nearly always read it ("ID:DIEGOADRIANPERE"), so this posts to the
  // SAME endpoint the "move" control uses: a vendor_override, which outranks every
  // inference on every surface and is undoable from the row it lands on.
  const claimContestedPull = async (row, claimant) => {
    const target = String(claimant.ledger_payee || claimant.payee || '').trim()
    if (!target || attachBusy || !row.funding_contested) return
    setAttachBusy(true)
    setAttachErr('')
    try {
      await api.post(`/statements/tx/${row.funding_contested.bank_id}/vendor`, { ledger_payee: target })
      await refreshMatching()
    } catch (err) {
      setAttachErr(err.response?.data?.error || err.message)
    } finally { setAttachBusy(false) }
  }

  const clearBankRowVendor = async (row) => {
    if (attachBusy) return
    setAttachBusy(true)
    setAttachErr('')
    try {
      await api.post(`/statements/tx/${row.id}/vendor`, { clear: true })
      await refreshMatching()
    } catch (err) { setAttachErr(err.response?.data?.error || err.message) }
    finally { setAttachBusy(false) }
  }

  // Ticked bank lines, for answering several at once. A vendor's lines are
  // already the right grouping — TONE has 10 waiting, SPOTIFY 151 — and the
  // per-row action cannot get through that.
  const [lineSel, setLineSel] = useState(() => new Set())

  const bulkNoInvoiceLines = async (ids, opts = {}) => {
    if (attachBusy || !ids.length) return
    if (!opts.confirmNew && !window.confirm(
      `Mark ${ids.length} payment${ids.length === 1 ? '' : 's'} as never needing an invoice?\n\n`
      + 'They stop being asked about. Nothing moves in the ledger, and each can be put back from its row.')) return
    setAttachBusy(true)
    setAttachErr('')
    try {
      const { data } = await api.post('/statements/no-invoice/bulk',
        { txn_ids: ids, ...(opts.confirmNew ? { confirm_new: true } : {}) })
      const d = data.data || {}
      const paidHolds = (d.skipped || []).filter((x) => /already-paid invoice/i.test(String(x.reason)))
      if (paidHolds.length && !opts.confirmNew
        && window.confirm(`${d.done} marked. ${paidHolds.length} held back because an already-paid `
          + 'invoice looks like it covers them.\n\nOK marks those too.')) {
        setAttachBusy(false)
        return bulkNoInvoiceLines(paidHolds.map((x) => x.id), { confirmNew: true })
      }
      if ((d.skipped || []).length && !paidHolds.length) {
        setAttachErr(`${d.done} marked · ${d.skipped.length} skipped (${d.skipped[0]?.reason})`)
      }
      setLineSel(new Set())
      await refreshMatching()
    } catch (err) {
      setAttachErr(err.response?.data?.error || err.message)
    } finally { setAttachBusy(false) }
  }

  // "This vendor never sends invoices" — the only thing that can clear a pile.
  //
  // FACEBOOK has 195 bank lines needing a decision, SPOTIFY 151, UBER 133. None
  // will ever have an invoice, and a per-line action cannot touch that: only 19
  // lines have EVER been dismissed one at a time. This writes the vendor-scope
  // rule that already exists (statement_no_invoice_rules) and answers all of
  // them at once.
  //
  // It writes a pattern for the ledger name AND for every bank payee in this
  // vendor's alias group. The rule matches by EQUALITY, never substring — the
  // table's own invariant, because "TONE" is a substring of "Tone Pay, Inc" — so
  // without the variants a rule on the ledger name would silently miss the lines
  // that arrive as "TONE PAY INC".
  //
  // Nothing is written to the ledger, which is why deleting the rule on /bk/rules
  // puts every one of these rows straight back.
  const markVendorNoInvoice = async (lines) => {
    if (attachBusy || !vendorDetail?.payee) return
    const patterns = [...new Set([
      vendorDetail.payee,
      ...((bankAct?.payees || []).map((p) => p.name).filter(Boolean)),
    ].map((s) => String(s).trim()).filter((s) => s.length >= 3))]
    if (!window.confirm(
      `Mark every payment to this vendor as never needing an invoice?\n\n`
      + `${lines} line${lines === 1 ? '' : 's'} here are waiting for one.\n\n`
      + `Writes a rule for: ${patterns.join(', ')}\n\n`
      + 'Nothing is written to the ledger and no money moves — this only stops these '
      + 'rows being asked about. Deleting the rule on the Upload Rules page puts them all back.')) return
    setAttachBusy(true)
    setAttachErr('')
    try {
      await api.post('/statements/no-invoice-rules', { scope: 'vendor', patterns })
      await refreshMatching()
    } catch (err) {
      setAttachErr(err.response?.data?.error || err.message)
    } finally { setAttachBusy(false) }
  }

  // NOTE: the old client-side unattach branched on match_method here to pick
  // /unrematch vs DELETE /match. That decision moved to /unattach on the server,
  // where it belongs: it also has to clear the links, and a client choosing the
  // wrong inverse is what left a row `open` — a state it was never in — in the
  // bug fixed by 6ef64a5.

  const handleScanW9s = async () => {
    setScanning(true)
    setScanResult(null)
    try {
      const res = await api.post('/bk/vendors/scan-w9s')
      setScanResult(res.data.data)
      if (res.data.data?.scanned > 0) fetchVendors()
      setTimeout(() => setScanResult(null), 6000)
    } catch (err) {
      setScanResult({ error: err.response?.data?.error || 'Scan failed' })
      setTimeout(() => setScanResult(null), 5000)
    } finally { setScanning(false) }
  }

  // W9 swap — accepts a file (from drag-drop or file picker), POSTs to
  // /bk/vendors/:payee/w9, then refetches so the badge + any open detail
  // view both reflect the new file.
  const [uploadingW9For, setUploadingW9For] = useState(null) // payee while upload in flight
  const [w9DragOverFor, setW9DragOverFor] = useState(null)   // payee currently being hovered
  const uploadW9 = async (payee, file) => {
    if (!file) return
    setUploadingW9For(payee)
    try {
      const fd = new FormData()
      fd.append('file', file)
      await api.post(`/bk/vendors/${encodeURIComponent(payee)}/w9`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      await fetchVendors()
      if (vendorDetail?.payee === payee) await fetchVendorDetail(payee)
    } catch (err) {
      alert('Failed to upload W9: ' + (err.response?.data?.error || err.message))
    } finally {
      setUploadingW9For(null)
    }
  }

  // Bundle every invoice + W9 + a styled Excel ledger for the current
  // vendor into a single ZIP via /api/bk/vendor-zip.
  const [zipBusyFor, setZipBusyFor] = useState(null) // payee while build in flight
  const handleDownloadVendorZip = async (payee) => {
    if (!payee || zipBusyFor) return
    setZipBusyFor(payee)
    try {
      const res = await api.get('/bk/vendor-zip', {
        params: { payee },
        responseType: 'blob',
      })
      // Server returns a JSON error body when something's wrong; the
      // blob's content-type tells us which shape arrived.
      if (res.data && res.data.type && /json/i.test(res.data.type)) {
        const text = await res.data.text()
        try { const j = JSON.parse(text); throw new Error(j.error || 'Failed to build ZIP') }
        catch (e) { throw e }
      }
      const url = URL.createObjectURL(res.data)
      const a = document.createElement('a')
      a.href = url
      a.download = `${payee.replace(/[^a-zA-Z0-9_-]/g, '_')}-${new Date().toISOString().slice(0,10)}.zip`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      let msg = err.response?.data?.error || err.message || 'Failed to build ZIP'
      if (err.response?.data instanceof Blob) {
        try { const j = JSON.parse(await err.response.data.text()); msg = j.error || msg } catch {}
      }
      alert(msg)
    } finally {
      setZipBusyFor(null)
    }
  }

  const handleRename = async (oldName) => {
    if (!editName.trim() || editName.trim() === oldName) { setEditingVendor(null); return }
    setSavingRename(true)
    try {
      const newName = editName.trim()
      await api.put('/bk/vendors/rename', { oldName, newName })
      setEditingVendor(null)
      fetchVendors()
      // If we're in vendor detail view, refresh with the new name
      if (urlVendorName) {
        fetchVendorDetail(newName)
      }
    } catch (err) {
      alert('Rename failed: ' + (err.response?.data?.error || err.message))
    } finally { setSavingRename(false) }
  }

  const handleMerge = async (source) => {
    if (!mergeTarget.trim()) return
    // Identical spelling is a true no-op. Case/whitespace variants are NOT —
    // the list groups by exact payee, so merging "EDUARDO..." into "Eduardo..."
    // is how you unify the casing. Only block the exact-same string.
    if (mergeTarget.trim() === source.trim()) {
      alert('Source and target are the same vendor name — nothing to merge.')
      return
    }
    if (!window.confirm(`Merge "${source}" into "${mergeTarget}"? All invoices from "${source}" will be reassigned to "${mergeTarget}".`)) return
    try {
      const target = mergeTarget.trim()
      await api.post('/bk/vendors/merge', { source, target })
      setShowMerge(null)
      setMergeTarget('')
      fetchVendors()
      // If we're on the source vendor's page, navigate to the target
      if (urlVendorName) navigate(`/bk/vendors/${encodeURIComponent(target)}`)
    } catch (err) { alert('Merge failed: ' + (err.response?.data?.error || err.message)) }
  }

  const fetchAliases = async (payee) => {
    try {
      const res = await api.get(`/bk/vendors/aliases/${encodeURIComponent(payee)}`)
      setAliases(res.data.data || [])
    } catch { setAliases([]) }
  }

  const addAlias = async (primaryName) => {
    if (!newAlias.trim()) return
    try {
      await api.post('/bk/vendors/aliases', { primary_name: primaryName, alias: newAlias.trim() })
      setNewAlias('')
      fetchAliases(primaryName)
    } catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
  }

  const toggleMergeSelect = (payee) => {
    setMergeSelection(prev => {
      const next = new Set(prev)
      if (next.has(payee)) next.delete(payee); else next.add(payee)
      return next
    })
  }

  const runBulkMerge = async () => {
    if (bulkMerging) return
    const target = bulkMergeTarget
    const sources = [...mergeSelection].filter(p => p !== target)
    if (!target || sources.length === 0) return
    if (!window.confirm(
      `Merge ${sources.length} vendor${sources.length === 1 ? '' : 's'} into "${target}"?\n\n` +
      sources.map(s => `• ${s}`).join('\n') +
      `\n\nAll their invoices move to "${target}" and the old names become aliases.`
    )) return
    setBulkMerging(true)
    const failures = []
    // Sequential — merges rename rows the next merge may need to match on.
    for (const source of sources) {
      try {
        await api.post('/bk/vendors/merge', { source, target })
      } catch (err) {
        failures.push(`${source}: ${err.response?.data?.error || err.message}`)
      }
    }
    setBulkMerging(false)
    setBulkMergeOpen(false)
    setMergeSelection(new Set())
    setBulkMergeTarget('')
    fetchVendors()
    if (failures.length) alert(`Some merges failed:\n${failures.join('\n')}`)
  }

  const removeAlias = async (id, primaryName) => {
    try {
      await api.delete(`/bk/vendors/aliases/${id}`)
      fetchAliases(primaryName)
    } catch {}
  }

  // Saved vendor emails — extra addresses that default into the CC line on
  // payment-confirmation emails. Alias-aware server-side.
  const fetchVendorEmails = async (payee) => {
    try {
      const res = await api.get(`/bk/vendors/emails/${encodeURIComponent(payee)}`)
      setVendorEmails(res.data.data || [])
    } catch { setVendorEmails([]) }
  }

  const addVendorEmail = async (payee) => {
    const email = newEmail.trim()
    if (!email) return
    try {
      await api.post('/bk/vendors/emails', { payee, email, label: newEmailLabel.trim() || undefined })
      setNewEmail('')
      setNewEmailLabel('')
      fetchVendorEmails(payee)
    } catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
  }

  const removeVendorEmail = async (id, payee) => {
    try {
      await api.delete(`/bk/vendors/emails/${id}`)
      fetchVendorEmails(payee)
    } catch {}
  }

  useEffect(() => { fetchVendors() }, [])
  // Advisory: a failure leaves the button hidden rather than breaking the page —
  // the directory itself must not depend on the duplicate sensor.
  const fetchDupes = async () => {
    try { setDupes((await api.get('/bk/vendor-duplicates')).data.data || []) } catch { /* advisory */ }
  }
  useEffect(() => { fetchDupes() }, [])

  // Load vendor detail from URL param
  useEffect(() => {
    if (urlVendorName) {
      const decoded = decodeURIComponent(urlVendorName)
      if (!vendorDetail || vendorDetail.payee !== decoded) {
        fetchVendorDetail(decoded, true)
      }
    } else {
      setVendorDetail(null)
    }
  }, [urlVendorName])

  const filtered = useMemo(() => {
    let list = [...vendors]
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(v =>
        (v.payee || '').toLowerCase().includes(q) ||
        (v.vendor_email || '').toLowerCase().includes(q) ||
        (v.aliases || '').toLowerCase().includes(q)
      )
    }
    if (w9Filter === 'W9 on file') list = list.filter(v => v.w9_on_file)
    else if (w9Filter === 'Missing W9') list = list.filter(v => !v.w9_on_file)
    else if (w9Filter === 'Name Mismatch') list = list.filter(v => v.w9_mismatch)

    if (sortBy === 'Spent: high') list.sort((a, b) => (b.total_spent || 0) - (a.total_spent || 0))
    else if (sortBy === 'Spent: low') list.sort((a, b) => (a.total_spent || 0) - (b.total_spent || 0))
    else if (sortBy === 'Name A-Z') list.sort((a, b) => (a.payee || '').localeCompare(b.payee || ''))
    else if (sortBy === 'Name Z-A') list.sort((a, b) => (b.payee || '').localeCompare(a.payee || ''))
    else if (sortBy === 'Most invoices') list.sort((a, b) => (b.invoice_count || 0) - (a.invoice_count || 0))
    else if (sortBy === 'Recent first') list.sort((a, b) => new Date(b.last_invoice || 0) - new Date(a.last_invoice || 0))
    return list
  }, [vendors, search, sortBy, w9Filter])

  if (loading && !urlVendorName) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '24rem' }}>
        <div style={{ textAlign: 'center' }}>
          <Loader style={{ width: 28, height: 28, color: RED, margin: '0 auto 8px', animation: 'spin 0.8s linear infinite' }} />
          <p style={{ color: '#777', fontSize: 14 }}>Loading vendors…</p>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      </div>
    )
  }

  // ── Detail view ──
  if (urlVendorName && !vendorDetail) {
    // Fetch failure used to strand the user on an infinite spinner — the
    // only error banner lived in the list view, unreachable from here.
    if (error && !detailLoading) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '24rem' }}>
          <div style={{ textAlign: 'center', maxWidth: 420 }}>
            <AlertCircle style={{ width: 28, height: 28, color: RED, margin: '0 auto 8px' }} />
            <p style={{ color: C.text, fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Couldn't load this vendor</p>
            <p style={{ color: '#888', fontSize: 12, marginBottom: 14 }}>{error}</p>
            <button
              onClick={() => { setError(''); fetchVendorDetail(decodeURIComponent(urlVendorName), true) }}
              style={{ background: RED, color: '#fff', border: 'none', borderRadius: 8, padding: '8px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', marginRight: 8 }}
            >
              Retry
            </button>
            <button
              onClick={() => navigate('/bk/vendors')}
              style={{ background: 'none', border: '1.5px solid ' + C.border, color: C.textMuted, borderRadius: 8, padding: '8px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
            >
              Back to vendors
            </button>
          </div>
        </div>
      )
    }
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '24rem' }}>
        <div style={{ textAlign: 'center' }}>
          <Loader style={{ width: 28, height: 28, color: RED, margin: '0 auto 8px', animation: 'spin 0.8s linear infinite' }} />
          <p style={{ color: '#777', fontSize: 14 }}>Loading vendor…</p>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      </div>
    )
  }
  if (urlVendorName && vendorDetail) {
    const invoices = vendorDetail.invoices || []
    // Group once, here, so the search bar's count and the table's rows are
    // derived from the same filter — computing them separately is how the
    // header stats on this very page came to disagree with each other.
    const invChildrenOf = {}
    const invRoots = []
    invoices.forEach((inv) => {
      if (inv.parent_id) {
        if (!invChildrenOf[inv.parent_id]) invChildrenOf[inv.parent_id] = []
        invChildrenOf[inv.parent_id].push(inv)
      } else invRoots.push(inv)
    })
    // A family matches when the root OR any child does, so a split invoice is
    // never half-shown and its rolled-up total stays explainable.
    // One picker for both moves — an invoice's payee and a bank payee's company
    // are different writes, but choosing the destination is the same act.
    const movePicker = (onPick) => (
      <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6 }}
        onClick={(e) => e.stopPropagation()}>
        <input autoFocus value={moveQ} onChange={(e) => onMoveQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && closeMove()}
          placeholder="Move to vendor…"
          style={{ background: C.inputBg, border: '1.5px solid ' + C.inputBorder, borderRadius: 6,
            padding: '3px 8px', color: C.text, fontSize: 12, fontFamily: 'inherit', outline: 'none', width: 190 }} />
        <button onClick={closeMove} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.textFaint, padding: 0 }}>
          <X style={{ width: 13, height: 13 }} />
        </button>
        {(() => {
          const q = moveQ.trim()
          // The vendor you are moving to may not exist yet — that is the normal
          // case for a payment whose bank text names nobody. Without this the
          // picker was a dead end: type the name, get an empty list, and the
          // server refuses it anyway (deliberately, so a typo cannot invent a
          // company). Offering it explicitly makes creating one a decision
          // rather than an accident, and the name is not typed twice.
          const exact = moveOpts.some((v) => v.name.toLowerCase() === q.toLowerCase())
          const showCreate = q.length >= 2 && !exact
          if (!moveOpts.length && !showCreate) return null
          return (
            <span style={{ position: 'absolute', top: '100%', left: 0, zIndex: 30, marginTop: 4, width: 250,
              background: C.cardBg, border: '1px solid ' + C.border, borderRadius: 8, overflow: 'hidden',
              boxShadow: '0 8px 24px rgba(0,0,0,0.18)', display: 'block' }}>
              {moveOpts.map((v) => (
                <button key={v.name} onClick={() => onPick(v.name)} disabled={attachBusy}
                  style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none',
                    padding: '6px 10px', cursor: 'pointer', color: C.text, fontSize: 12, fontFamily: 'inherit' }}>
                  {v.name} <span style={{ color: C.textFaint }}>· {v.invoice_count} inv</span>
                </button>
              ))}
              {showCreate && (
                <button onClick={() => onPick(q, { createNew: true })} disabled={attachBusy}
                  title={`No vendor is called "${q}" yet. This files the payment under that name and the vendor comes into existence with it.`}
                  style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none',
                    borderTop: moveOpts.length ? '1px solid ' + C.border : 'none', borderLeft: 'none',
                    borderRight: 'none', borderBottom: 'none',
                    padding: '6px 10px', cursor: 'pointer', color: C.text, fontSize: 12,
                    fontWeight: 700, fontFamily: 'inherit' }}>
                  + Create vendor “{q}”
                  <span style={{ display: 'block', fontWeight: 500, fontSize: 10.5, color: C.textFaint }}>
                    {moveOpts.length ? 'none of the above' : 'no existing vendor matches'}
                  </span>
                </button>
              )}
            </span>
          )
        })()}
      </span>
    )

    // INVOICES vs ENTRIES WE INVENTED FROM A BANK LINE.
    //
    // Both live in `expenses` under this payee, so the table showed them as one
    // list — and a bank-born row has no invoice number, no file, no artist and a
    // raw bank descriptor for a description ("WIRE TYPE:WIRE OUT DATE:260407…").
    // On STURDY.CO that is 3 rows among 4 real invoices, which makes the invoice
    // list look broken and hides the fact that those three are exactly the rows
    // still needing an invoice.
    //
    // Client-side, because /bk/vendors/:payee already returns entry_source on
    // every row — no new query for a question the page can already answer.
    const isBankBorn = (inv) => inv.entry_source === 'bank_statement'
    const invVisibleRoots = invRoots.filter((inv) => matchesQuery(invQ, [
      inv.payee, inv.description, inv.category, inv.artist, inv.song,
      inv.invoice_number, inv.amount, inv.currency,
      inv.payment_status, inv.payment_method, inv.payment_date, inv.invoice_date,
      ...(invChildrenOf[inv.id] || []).flatMap((c) => [c.artist, c.song, c.category, c.amount]),
    ]))
    const visibleRootCount = invVisibleRoots.length
    // Family total, defined ONCE for the page. The stats block below used to
    // rebuild its own childTotals map for the same answer; two derivations of
    // "what does this invoice settle for" is how the matcher and the totals
    // would come to disagree about the same vendor.
    const invFamilyTotal = (r) => parseFloat(r.amount || 0)
      + (invChildrenOf[r.id] || []).reduce((s, c) => s + parseFloat(c.amount || 0), 0)

    // A group's total, currency-honest.
    //
    // Face values may NOT be added across currencies — a €1,000 invoice is not
    // 1,000 of the same thing as a $1,000 one, and summing them is how this
    // codebase reported $6,159,482 against a real $5,772,443. So: one currency
    // in the group means a plain total in it; more than one means the USD
    // equivalent through itemsToUsd, which honours each row's LOCKED rate, and
    // the label says so rather than implying a native figure.
    //
    // Children are included because they are hidden by default and the root
    // shows the family total — a footer that summed only visible rows would
    // disagree with the column above it.
    const groupTotal = (roots) => {
      const items = roots.flatMap((r) => [r, ...(invChildrenOf[r.id] || [])])
      if (!items.length) return null
      const curs = new Set(items.map((e) => String(e.currency || 'USD').toUpperCase()))
      if (curs.size === 1) {
        const cur = [...curs][0]
        // Round ONCE, at the end: totalling already-rounded parts has broken a
        // tie-out here by exactly a cent before.
        const native = fmt(roots.reduce((n, r) => n + invFamilyTotal(r), 0), cur)
        if (cur === 'USD') return { text: native, mixed: false }
        // A EUR-only vendor's total is honest in EUR and unusable next to every
        // other figure on the page, all of which are dollars. Both, native first
        // — the invoices really were denominated in it.
        const usd = itemsToUsd(items, fxRates)
        return { text: native, mixed: false,
          usd: usd == null ? null : `≈ ${fmt(usd, 'USD')}`, currencies: cur }
      }
      const usd = itemsToUsd(items, fxRates)
      if (usd == null) return { text: '—', mixed: true }
      return { text: `≈ ${fmt(usd, 'USD')}`, mixed: true, currencies: [...curs].sort().join(', ') }
    }

    // ── The matching work on this vendor: invoices a bank line owes ──
    //
    // Same test as the directory's `to_attach` and as the Flags paid-no-match
    // count — Paid, a ready statement's period covers the payment date and is
    // method-compatible (`bank_expected`), and nothing is matched to it
    // (`bank_evidence`). Derived from the rows already on the page, so the header
    // count and the picker below it can never disagree with the dots in the
    // table above them.
    //
    // Unpaid invoices are deliberately absent: no bank line should exist yet, so
    // listing them as work would make a number that can never reach zero.
    // Booked lines naming no artist. Derived from the rows the panel LISTS, so
    // the band, the chip and the directory column cannot report three numbers.
    const needsArtistRows = (bankAct?.transactions || []).filter((t) => t.needs_artist)
    // PayPal is a different statement with a different meaning, not another bank
    // row: every PayPal payment is ALSO on the bank statement as a nameless
    // "PAYPAL DES:…" pull, so the two mixed into one list read as double the
    // spend with no way to tell which is which.
    const ppRows = (bankAct?.transactions || []).filter((t) => t.account === 'paypal')
    const bankRowsOnly = (bankAct?.transactions || []).filter((t) => t.account !== 'paypal')
    const unattached = invRoots
      .filter((inv) => inv.payment_status === 'Paid' && inv.bank_expected && !inv.bank_evidence)
      .map((inv) => ({ ...inv, family_total: invFamilyTotal(inv) }))

    // What the picker may OFFER is deliberately wider than what the count claims:
    // any invoice of this vendor's with no bank line behind it, paid or not.
    //
    // An invoice entered but never marked Paid, whose money plainly did leave the
    // bank, is one of the commonest real cases — and it is exactly what a person
    // looking at this vendor can see. Excluding it would make the picker unable to
    // settle a line the evidence settles. The matcher's own pool has never
    // filtered on payment status either.
    //
    // The COUNT stays strict (Paid · expected · unattached) because it has to mean
    // "work that exists" and agree with the directory; an unpaid invoice is not a
    // reconciliation gap, it is an unpaid invoice.
    const attachable = invRoots
      .filter((inv) => !inv.bank_evidence)
      .map((inv) => ({ ...inv, family_total: invFamilyTotal(inv) }))
    return (
      <div data-tour="vendor-page" style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.pageBg, fontSize: 14 }}>
        {/* Breadcrumb bar */}
        <div style={{
          padding: '10px 16px', display: 'flex', gap: 6, alignItems: 'center',
          borderBottom: '1px solid ' + C.border, background: C.cardBg,
          position: 'sticky', top: 0, zIndex: 10, fontSize: 12, color: C.textFaint,
        }}>
          <button
            onClick={() => navigate('/bk/vendors')}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: 12, fontFamily: 'inherit' }}
          >
            Finance
          </button>
          <ChevronRight style={{ width: 11, height: 11, color: '#d1d5db' }} />
          <button
            onClick={() => navigate('/bk/vendors')}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: 12, fontFamily: 'inherit' }}
          >
            Vendors
          </button>
          <ChevronRight style={{ width: 11, height: 11, color: '#d1d5db' }} />
          <span style={{ color: C.text, fontWeight: 600 }}>{vendorDetail.payee}</span>
        </div>

        {/* Vendor header card */}
        <div style={{ margin: '16px 16px 0', background: C.cardBg, borderRadius: 10, border: '1.5px solid ' + C.border, padding: '20px 24px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
            <div>
              {editingVendor === vendorDetail.payee ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                  <input
                    type="text" value={editName} onChange={e => setEditName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { handleRename(vendorDetail.payee); } if (e.key === 'Escape') setEditingVendor(null) }}
                    autoFocus
                    style={{ border: '1.5px solid ' + RED, borderRadius: 6, padding: '4px 10px', fontSize: 20, fontWeight: 800, color: C.text, background: C.inputBg, outline: 'none', width: 320, fontFamily: 'inherit' }}
                  />
                  <button onClick={() => handleRename(vendorDetail.payee)} disabled={savingRename}
                    style={{ background: RED, color: '#fff', border: 'none', borderRadius: 6, padding: '6px 10px', cursor: 'pointer', display: 'flex' }}>
                    <Check style={{ width: 16, height: 16 }} />
                  </button>
                  <button onClick={() => setEditingVendor(null)}
                    style={{ background: C.elevBg, color: C.textMuted, border: '1px solid ' + C.border, borderRadius: 6, padding: '6px 10px', cursor: 'pointer', display: 'flex' }}>
                    <X style={{ width: 16, height: 16 }} />
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <h1 style={{ fontSize: 22, fontWeight: 800, color: C.text, margin: 0 }}>{vendorDetail.payee}</h1>
                  <button
                    onClick={() => { setEditingVendor(vendorDetail.payee); setEditName(vendorDetail.payee) }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ccc', padding: 4, display: 'flex', transition: 'color 0.15s' }}
                    onMouseEnter={e => e.currentTarget.style.color = '#666'}
                    onMouseLeave={e => e.currentTarget.style.color = '#ccc'}
                    title="Rename vendor"
                  >
                    <Pencil style={{ width: 14, height: 14 }} />
                  </button>
                </div>
              )}
              {vendorDetail.vendor_email && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#777' }}>
                  <Mail style={{ width: 14, height: 14 }} /> {vendorDetail.vendor_email}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {/* Download bundle — every invoice + W9 + a styled Excel
                  ledger for this vendor as a single ZIP. Disabled when
                  the vendor has no invoices on file (the endpoint would
                  404). Powered by GET /api/bk/vendor-zip. */}
              {(() => {
                const payee = vendorDetail.payee
                const busy = zipBusyFor === payee
                const noInvoices = invoices.length === 0
                return (
                  <button
                    onClick={() => handleDownloadVendorZip(payee)}
                    disabled={busy || noInvoices}
                    title={noInvoices
                      ? 'No invoices on file for this vendor'
                      : `Download ZIP — every invoice + W9 + ledger for ${payee}`}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      border: `1px solid ${C.border}`,
                      borderRadius: 8, padding: '6px 12px',
                      background: busy ? C.elevBg : C.cardBg,
                      cursor: (busy || noInvoices) ? 'not-allowed' : 'pointer',
                      opacity: noInvoices ? 0.5 : 1,
                      fontSize: 11, fontWeight: 600, color: C.text,
                      fontFamily: 'inherit', transition: 'all 0.15s',
                    }}
                    onMouseEnter={e => { if (!busy && !noInvoices) e.currentTarget.style.background = C.elevBg }}
                    onMouseLeave={e => { if (!busy && !noInvoices) e.currentTarget.style.background = C.cardBg }}
                  >
                    {busy
                      ? <Loader style={{ width: 12, height: 12, animation: 'spin 0.8s linear infinite' }} />
                      : <Package style={{ width: 12, height: 12 }} />}
                    {busy ? 'Building ZIP…' : 'Download bundle'}
                  </button>
                )
              })()}
              {vendorDetail.w9_on_file ? (
                <span style={W9_YES}>
                  <span style={{ marginRight: 4 }}>✓</span> W9
                </span>
              ) : (
                <span style={W9_NO}>No W9</span>
              )}
              {(() => {
                const payee = vendorDetail.payee
                const busy = uploadingW9For === payee
                const over = w9DragOverFor === payee
                const title = vendorDetail.w9_on_file ? 'Replace W9 — drop a file here or click' : 'Upload W9 — drop a file here or click'
                return (
                  <div
                    onDragOver={e => { e.preventDefault(); e.stopPropagation(); setW9DragOverFor(payee) }}
                    onDragLeave={e => { e.stopPropagation(); setW9DragOverFor(null) }}
                    onDrop={e => {
                      e.preventDefault(); e.stopPropagation(); setW9DragOverFor(null)
                      const file = e.dataTransfer.files?.[0]
                      if (file) uploadW9(payee, file)
                    }}
                    onClick={() => !busy && document.getElementById(`w9-input-detail`)?.click()}
                    title={title}
                    style={{
                      border: `1.5px dashed ${over ? '#6366f1' : C.border}`,
                      borderRadius: 8, padding: '6px 14px', cursor: busy ? 'default' : 'pointer',
                      background: over ? '#eef2ff' : C.elevBg,
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      fontSize: 11, fontWeight: 600, color: C.textMuted,
                      transition: 'all 0.15s', opacity: busy ? 0.6 : 1,
                    }}
                  >
                    {busy
                      ? <Loader style={{ width: 12, height: 12, animation: 'spin 0.8s linear infinite' }} />
                      : <Upload style={{ width: 12, height: 12 }} />}
                    {busy ? 'Uploading…' : (vendorDetail.w9_on_file ? 'Drop to replace W9' : 'Drop W9 here')}
                    <input
                      id="w9-input-detail"
                      type="file"
                      accept=".pdf,.png,.jpg,.jpeg"
                      style={{ display: 'none' }}
                      onChange={e => {
                        const file = e.target.files?.[0]
                        if (file) uploadW9(payee, file)
                        e.target.value = ''
                      }}
                    />
                  </div>
                )
              })()}
            </div>
          </div>
          {/* Header stats — ONE computation for all four figures.
              They used to be computed three separate ways and disagreed:
              Total Spent summed every row (parent + split children), Invoices
              counted every row, but Paid / Outstanding summed only ROOT rows'
              OWN amounts — silently dropping every split child from the money.
              On a vendor with one 3-way split that read as Total $76,571.71 /
              14 invoices / Paid $65,369.10 across 12: the $11,202.61 held by
              the children vanished, and 12 paid + 0 outstanding didn't add up
              to 14.
              Now a family (a root plus its children) is the unit everywhere,
              which makes two invariants hold by construction:
                Total Spent === Paid + Outstanding
                Invoices    === paid count + outstanding count
              Amounts stay grouped by currency so a mixed-currency vendor
              doesn't sum EUR + USD into a nonsense figure; a family takes its
              root's currency, which is how splits are created. */}
          {(() => {
            const roots = invRoots
            const familyTotal = invFamilyTotal

            const paidRoots = roots.filter(r => r.payment_status === 'Paid')
            const unpaidRoots = roots.filter(r => r.payment_status !== 'Paid')
            const byCurrency = (list) => list.reduce((m, r) => {
              const cur = (r.currency || 'USD').toUpperCase()
              m[cur] = (m[cur] || 0) + familyTotal(r)
              return m
            }, {})
            const formatTotals = (map) => {
              const entries = Object.entries(map)
              if (!entries.length) return fmt(0)
              entries.sort(([a], [b]) => a === 'USD' ? -1 : b === 'USD' ? 1 : a.localeCompare(b))
              return entries.map(([c, v]) => fmt(v, c)).join(' · ')
            }
            const label = (n) => `${n} ${n === 1 ? 'invoice' : 'invoices'}`

            return (
              <div style={{ display: 'flex', gap: 32, marginTop: 16, paddingTop: 16, borderTop: '1px solid ' + C.tdBorder, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', color: C.textFaint, marginBottom: 4 }}>Total Spent</div>
                  <div style={{ fontSize: 20, fontWeight: 900, color: C.text }}>{formatTotals(byCurrency(roots))}</div>
                </div>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', color: C.textFaint, marginBottom: 4 }}>Invoices</div>
                  <div style={{ fontSize: 20, fontWeight: 900, color: C.text }}>{roots.length}</div>
                  {roots.length !== invoices.length && (
                    <div style={{ fontSize: 11, color: C.textFaint, marginTop: 2 }}>
                      {invoices.length - roots.length} split {invoices.length - roots.length === 1 ? 'row' : 'rows'} rolled up
                    </div>
                  )}
                </div>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', color: C.textFaint, marginBottom: 4 }}>Paid</div>
                  <div style={{ fontSize: 20, fontWeight: 900, color: '#065f46' }}>{formatTotals(byCurrency(paidRoots))}</div>
                  <div style={{ fontSize: 11, color: C.textFaint, marginTop: 2 }}>{label(paidRoots.length)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.07em', color: C.textFaint, marginBottom: 4 }}>Outstanding</div>
                  <div style={{ fontSize: 20, fontWeight: 900, color: unpaidRoots.length ? '#991b1b' : C.textFaint }}>{formatTotals(byCurrency(unpaidRoots))}</div>
                  <div style={{ fontSize: 11, color: C.textFaint, marginTop: 2 }}>{label(unpaidRoots.length)}</div>
                </div>
              </div>
            )
          })()}
        </div>

        {/* ── Tabs ─────────────────────────────────────────────────────────
            John, 2026-08-19: "clean up the vendors page to be less messy."
            The detail view stacked 11 blocks — emails, aliases, merged-into,
            the ledger table with its two created-from bands, bank activity and
            PayPal activity — and you scrolled past the setup every single time
            to reach the work.

            Same underline language the rest of the app uses (Release Tracker,
            Team, Bank Matching), expressed in inline styles because this is one
            of the six getDarkColors pages and Tailwind classes here would only
            half-theme.

            Counts come from the SAME arrays the bodies render, never a second
            query — a band whose number disagrees with the list under it is the
            failure logged as task #73. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, margin: '14px 16px 0',
          borderBottom: '1px solid ' + C.border }}>
          {[
            // ONE pane for the work, not two.
            //
            // The first cut of this put invoices and bank activity in separate
            // tabs, and John's answer was immediate: "I liked being able to see
            // bank activity and paypal activity, I just wanted it organized."
            // He is right — reconciling the ledger against the statement is the
            // whole job of this page, and tabs had put the two halves of that
            // comparison where they could not be seen at once.
            //
            // Setup stays behind a tab. That part was correct: emails, aliases
            // and merged-into are configured once and were sitting above the
            // work every time you opened a vendor.
            ['activity', 'Activity', invoices.length + (bankAct ? bankRowsOnly.length + ppRows.length : 0)],
            ['setup', 'Setup', null],
          ].map(([key, label, count]) => {
            // Bank activity is hidden for roles without statements access and
            // for vendors with no bank presence — the same condition the card
            // itself carries, so a tab can never lead to an empty panel.
            const on = vendorTab === key
            return (
              <button
                key={key}
                onClick={() => setVendorTab(key)}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                  padding: '8px 0 9px', fontSize: 13, fontWeight: on ? 800 : 600,
                  color: on ? RED : C.textMuted,
                  borderBottom: '2px solid ' + (on ? RED : 'transparent'),
                  marginBottom: -1, display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                {label}
                {count > 0 && (
                  <span style={{ fontSize: 11, fontWeight: 700, color: on ? RED : C.textFaint, fontVariantNumeric: 'tabular-nums' }}>
                    {count}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        {vendorTab === 'setup' && (<>
        {/* ── How we pay them ──────────────────────────────────────────────
            Collected on the vendor form since 2026-08-26. Before that the
            account and routing numbers existed only inside the uploaded PDF, so
            paying somebody meant opening their invoice and reading it off — and
            an invoice that did not print them was refused outright.

            Masked until asked for, and asking is logged. */}
        <div style={{ margin: '12px 16px 0', background: C.cardBg, borderRadius: 10, border: '1px solid ' + C.border, padding: '14px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
            <CreditCard style={{ width: 13, height: 13, color: C.textMuted }} />
            <span style={{ fontSize: 12, fontWeight: 700, color: C.textMuted }}>Payment details</span>
            <span style={{ fontSize: 11, color: C.textFaint }}>— viewing them is recorded in the audit log</span>
            {!payDetails && (
              <button
                onClick={async () => {
                  setPayLoading(true); setPayErr('')
                  try {
                    const r = await api.get(`/bk/vendors/${encodeURIComponent(vendorDetail.payee)}/payment-details`)
                    setPayDetails(r.data?.data || { on_file: false })
                  } catch (e) {
                    setPayErr(e?.response?.data?.error || e.message)
                  } finally { setPayLoading(false) }
                }}
                style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: '#dc2626', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
                {payLoading ? 'Loading…' : 'Show'}
              </button>
            )}
          </div>
          {payErr && <div style={{ fontSize: 12, color: '#dc2626' }}>{payErr}</div>}
          {!payDetails && !payErr && (
            <div style={{ fontSize: 12, color: C.textFaint }}>Hidden. Click Show to reveal.</div>
          )}
          {payDetails && !payDetails.on_file && (
            <div style={{ fontSize: 12, color: C.textFaint }}>
              Nothing on file — this vendor has not submitted through the form since payment
              details became part of it. Their invoice is still the source.
            </div>
          )}
          {payDetails?.on_file && (
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 14px', fontSize: 12, color: C.text }}>
              {[
                ['Method', payDetails.method],
                ['Name on account', payDetails.holder_name],
                ['Account', payDetails.account_number],
                ['Routing', payDetails.routing_number],
                ['Account type', payDetails.account_type],
                ['IBAN / SWIFT', payDetails.iban_swift],
                ['PayPal', payDetails.paypal_handle],
                ['Bank name', payDetails.bank_name],
                ['Bank address', payDetails.bank_address],
                ['Beneficiary address', payDetails.beneficiary_address],
                ['Intermediary bank', payDetails.intermediary_bank],
                ['Updated', String(payDetails.updated_at || '').slice(0, 10)],
              ].filter(([, v]) => v).map(([k, v]) => (
                <Fragment key={k}>
                  <span style={{ color: C.textFaint }}>{k}</span>
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>{v}</span>
                </Fragment>
              ))}
              {payDetails.readable === false && (
                <span style={{ gridColumn: '1 / -1', color: '#d97706' }}>
                  Stored, but not readable — the encryption key is missing or has changed.
                  This is not the vendor failing to give us details.
                </span>
              )}
            </div>
          )}
        </div>

        {/* Email addresses — extras beyond the invoice email. These default
            into the CC line on payment-confirmation emails. */}
        <div style={{ margin: '12px 16px 0', background: C.cardBg, borderRadius: 10, border: '1px solid ' + C.border, padding: '14px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
            <Mail style={{ width: 13, height: 13, color: C.textMuted }} />
            <span style={{ fontSize: 12, fontWeight: 700, color: C.textMuted }}>
              Email addresses {vendorEmails.length > 0 && <span style={{ color: C.textFaint }}>({vendorEmails.length + (vendorDetail.vendor_email ? 1 : 0)})</span>}
            </span>
            <span style={{ fontSize: 11, color: C.textFaint }}>— saved emails are CC'd on payment confirmations</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            {vendorDetail.vendor_email && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: C.elevBg, border: '1px solid ' + C.border, borderRadius: 6, padding: '3px 8px', fontSize: 12, color: C.text }}>
                {vendorDetail.vendor_email}
                <span style={{ fontSize: 10, fontWeight: 700, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.04em' }}>on invoices</span>
              </span>
            )}
            {vendorEmails.map(v => (
              <span key={v.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: C.elevBg, border: '1px solid ' + C.border, borderRadius: 6, padding: '3px 8px', fontSize: 12, color: C.text }}>
                {v.email}
                {v.label && <span style={{ fontSize: 10, fontWeight: 700, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{v.label}</span>}
                <button onClick={() => removeVendorEmail(v.id, vendorDetail.payee)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ccc', fontSize: 14, padding: 0, lineHeight: 1 }}
                  onMouseEnter={e => e.currentTarget.style.color = '#dc2626'}
                  onMouseLeave={e => e.currentTarget.style.color = '#ccc'}>×</button>
              </span>
            ))}
            {!vendorDetail.vendor_email && vendorEmails.length === 0 && (
              <span style={{ fontSize: 12, color: C.textFaint }}>No emails on file yet.</span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addVendorEmail(vendorDetail.payee) }}
              placeholder="Add email address…"
              style={{ flex: 2, border: '1px solid ' + C.border, borderRadius: 6, padding: '5px 10px', fontSize: 12, color: C.text, background: C.inputBg, outline: 'none', fontFamily: 'inherit' }} />
            <input type="text" value={newEmailLabel} onChange={e => setNewEmailLabel(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addVendorEmail(vendorDetail.payee) }}
              placeholder="Label (optional — e.g. accounting)"
              style={{ flex: 1, border: '1px solid ' + C.border, borderRadius: 6, padding: '5px 10px', fontSize: 12, color: C.text, background: C.inputBg, outline: 'none', fontFamily: 'inherit' }} />
            <button onClick={() => addVendorEmail(vendorDetail.payee)} disabled={!newEmail.trim()}
              style={{ background: RED, color: '#fff', border: 'none', borderRadius: 6, padding: '5px 12px', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', opacity: newEmail.trim() ? 1 : 0.4 }}>
              Add
            </button>
          </div>
        </div>

        {/* Aliases & Merge */}
        <div style={{ margin: '12px 16px 0', background: C.cardBg, borderRadius: 10, border: '1px solid ' + C.border, padding: '14px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: aliases.length || showMerge ? 10 : 0 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: C.textMuted }}>
              Also known as {aliases.length > 0 && <span style={{ color: C.textFaint }}>({aliases.length})</span>}
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => setShowMerge(showMerge ? null : vendorDetail.payee)}
                style={{ background: 'none', border: '1px solid ' + C.border, borderRadius: 6, padding: '4px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer', color: C.textMuted, fontFamily: 'inherit' }}>
                Merge Vendor
              </button>
            </div>
          </div>
          {/* Existing aliases */}
          {aliases.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
              {aliases.map(a => (
                <span key={a.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: C.elevBg, border: '1px solid ' + C.border, borderRadius: 6, padding: '3px 8px', fontSize: 12, color: C.text }}>
                  {a.alias}
                  <button onClick={() => removeAlias(a.id, vendorDetail.payee)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ccc', fontSize: 14, padding: 0, lineHeight: 1 }}
                    onMouseEnter={e => e.currentTarget.style.color = '#dc2626'}
                    onMouseLeave={e => e.currentTarget.style.color = '#ccc'}>×</button>
                </span>
              ))}
            </div>
          )}
          {/* Add alias */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="text" value={newAlias} onChange={e => setNewAlias(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addAlias(vendorDetail.payee) }}
              placeholder="Add alternate name (DBA, business name...)"
              style={{ flex: 1, border: '1px solid ' + C.border, borderRadius: 6, padding: '5px 10px', fontSize: 12, color: C.text, background: C.inputBg, outline: 'none', fontFamily: 'inherit' }} />
            <button onClick={() => addAlias(vendorDetail.payee)} disabled={!newAlias.trim()}
              style={{ background: RED, color: '#fff', border: 'none', borderRadius: 6, padding: '5px 12px', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', opacity: newAlias.trim() ? 1 : 0.4 }}>
              Add
            </button>
          </div>
          {/* WHAT THIS VENDOR IS MADE OF, and the way back.
              A merge renames entries; the alias chip is only a label, so
              deleting the chip hides the history without reversing anything.
              This is the history, and it reverses BY ID — rows that were always
              the target are never dragged along. */}
          {merges.filter((m) => m.direction === 'into').length > 0 && (
            <div style={{ marginTop: 10, borderTop: '1px solid ' + C.tdBorder, paddingTop: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: C.textFaint, marginBottom: 6 }}>
                Merged into this vendor
              </div>
              {merges.filter((m) => m.direction === 'into').map((m) => (
                <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12, padding: '4px 0' }}>
                  <span style={{ fontWeight: 700, color: C.text }}>{m.source}</span>
                  <span style={{ color: C.textFaint }}>
                    {m.entries} entr{m.entries === 1 ? 'y' : 'ies'}
                    {m.bank_links ? ` · ${m.bank_links} bank link${m.bank_links === 1 ? '' : 's'}` : ''}
                    {' · '}{fmtDate(m.created_at)}{m.created_by ? ` by ${m.created_by}` : ''}
                  </span>
                  {m.undone_at ? (
                    <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: C.textFaint }}>
                      undone {fmtDate(m.undone_at)}
                    </span>
                  ) : (
                    <button onClick={() => unmergeVendor(m)} disabled={mergeBusy}
                      title={`Move those ${m.entries} entries back to "${m.source}" and make it a vendor again. Reverses by id, so rows that were always "${m.target}" stay put.`}
                      style={{ marginLeft: 'auto', background: 'none', border: '1px solid ' + C.border, borderRadius: 6,
                        padding: '3px 9px', fontSize: 11, fontWeight: 700, fontFamily: 'inherit',
                        cursor: mergeBusy ? 'default' : 'pointer', color: C.textMuted, opacity: mergeBusy ? 0.5 : 1 }}>
                      Unmerge
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {/* Merge UI */}
          {showMerge && (
            <div style={{ marginTop: 10, padding: '10px 14px', background: C.elevBg, border: '1px solid ' + C.border, borderRadius: 8 }}>
              <p style={{ fontSize: 12, color: C.textMuted, marginBottom: 8 }}>Merge <strong>{showMerge}</strong> into another vendor. All invoices will be moved.</p>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <div style={{ flex: 1 }}>
                  <SearchableSelect
                    value={mergeTarget}
                    onChange={setMergeTarget}
                    options={vendors.filter(v => v.payee !== showMerge).map(v => v.payee)}
                    placeholder="Type vendor name..."
                    style={{ width: '100%', border: '1px solid ' + C.border, borderRadius: 6, padding: '6px 10px', fontSize: 12, color: C.text, background: C.inputBg, fontFamily: 'inherit', outline: 'none' }}
                  />
                </div>
                <button onClick={() => handleMerge(showMerge)} disabled={!mergeTarget}
                  style={{ background: RED, color: '#fff', border: 'none', borderRadius: 6, padding: '6px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', opacity: mergeTarget ? 1 : 0.4, whiteSpace: 'nowrap' }}>
                  Merge
                </button>
                <button onClick={() => setShowMerge(null)}
                  style={{ background: C.elevBg, color: C.textMuted, border: '1px solid ' + C.border, borderRadius: 6, padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
        </>)}

        {/* Invoices table */}
        {vendorTab === 'activity' && (
        <div style={{ flex: 1, overflowX: 'auto', overflowY: 'auto', margin: '0 16px' }}>
          {detailLoading ? (
            <div style={{ textAlign: 'center', padding: '60px 20px' }}>
              <Loader style={{ width: 28, height: 28, color: RED, margin: '0 auto', animation: 'spin 0.8s linear infinite' }} />
              <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
            </div>
          ) : invoices.length > 0 ? (
            <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
            {/* Filter this vendor's invoices. Client-side: the detail endpoint
                returns every row for the vendor, so nothing is off-screen to
                miss. Matches the FAMILY, so a split stays whole when any part
                of it matches — filtering a parent away from its children would
                make the rolled-up total unexplainable. */}
            <div style={{ marginTop: 16 }}>
              <ListSearch
                value={invQ}
                onChange={setInvQ}
                placeholder="Filter invoices — payee, artist, song, category, inv #…"
                count={visibleRootCount}
                total={invoices.filter(i => !i.parent_id).length}
                width={320}
              />
              {/* The selection's own bar, beside the filter it was made under —
                  so "select all 12 matched" and "unmatch them" read as one
                  action rather than a control hunting for its subject. */}
              {(() => {
                // The bar now serves the WHOLE table, not just the matched subset.
                // Selecting is how you recategorize or flag several invoices at
                // once; unmatch is one action among three and keeps its own
                // narrower scope, stated on the button.
                const rows = invVisibleRoots
                if (rows.length === 0) return null
                const allSel = rows.length > 0 && rows.every((i) => invSel.has(i.id))
                const picked = rows.filter((i) => invSel.has(i.id))
                const chosen = picked.filter((i) => i.bank_evidence?.txn_id)
                const flaggedN = picked.filter((i) => i.flagged).length
                return (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12,
                      color: C.textMuted, cursor: 'pointer', fontWeight: 600 }}>
                      <input type="checkbox" checked={allSel} disabled={attachBusy}
                        onChange={() => setInvSel(allSel ? new Set() : new Set(rows.map((i) => i.id)))} />
                      Select all {rows.length}
                    </label>
                    <span style={{ fontSize: 12, color: C.textFaint }}>{picked.length} selected</span>
                    {picked.length > 0 && (
                      <>
                        {/* RECATEGORIZE. One picker, applied to every selected
                            invoice through the same PUT the inline editor uses —
                            not a new bulk endpoint, so the two cannot disagree
                            about what changing a category means. */}
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontSize: 12, color: C.textMuted, fontWeight: 600 }}>Category</span>
                          <CategorySelect kind="expense" value="" placeholder={`Set on ${picked.length}…`}
                            disabled={bulkBusy}
                            onChange={(v) => v && bulkSetCategory([...picked], v)}
                            style={{ border: '1px solid ' + C.border, borderRadius: 6, padding: '3px 8px',
                              fontSize: 12, fontFamily: 'inherit', background: C.cardBg, color: C.text, minWidth: 170 }} />
                        </span>
                        <button onClick={() => bulkFlag([...picked], true)} disabled={bulkBusy}
                          title="Flag these for review. They show on the Flags page until somebody clears them."
                          style={{ background: 'none', border: '1px solid ' + C.border, borderRadius: 6,
                            cursor: bulkBusy ? 'default' : 'pointer', color: '#e11d48', fontSize: 11.5,
                            fontWeight: 700, fontFamily: 'inherit', padding: '4px 10px', opacity: bulkBusy ? 0.5 : 1 }}>
                          ⚑ Flag {picked.length}
                        </button>
                        {flaggedN > 0 && (
                          <button onClick={() => bulkFlag([...picked], false)} disabled={bulkBusy}
                            title="Clear the flag on the selected rows that carry one."
                            style={{ background: 'none', border: 'none', padding: 0,
                              cursor: bulkBusy ? 'default' : 'pointer', color: C.textFaint, fontSize: 11.5,
                              fontWeight: 700, fontFamily: 'inherit', opacity: bulkBusy ? 0.5 : 1 }}>
                            clear flag · {flaggedN}
                          </button>
                        )}
                        {bulkNote && <span style={{ fontSize: 11.5, color: C.textFaint }}>{bulkNote}</span>}
                      </>
                    )}
                    {canSeeBank && chosen.length > 0 && (
                      <button
                        onClick={() => bulkUnmatch([...new Set(chosen.map((i) => i.bank_evidence.txn_id))])}
                        disabled={attachBusy}
                        title="Detach these invoices from the bank lines settling them. Each invoice goes back to waiting, and each payment returns to the queue."
                        style={{ background: 'none', border: '1px solid ' + C.border, borderRadius: 6,
                          cursor: attachBusy ? 'default' : 'pointer', color: C.textMuted, fontSize: 11.5,
                          fontWeight: 700, fontFamily: 'inherit', padding: '4px 10px', opacity: attachBusy ? 0.5 : 1 }}>
                        Unmatch · {chosen.length} with a bank line
                      </button>
                    )}
                  </div>
                )
              })()}
              {/* WHAT THE HUE MEANS. A tint nobody can decode is decoration, so
                  the count and a swatch sit above the table — and only when there
                  is something to explain. Rendered outside the select-all block on
                  purpose: that one is gated on bank permissions, and provenance is
                  not a bank question. */}
              {(() => {
                const added = invVisibleRoots.filter((i) => !isBankBorn(i) && !i.vendor_submitted)
                if (!added.length) return null
                const total = added.reduce((sum, i) => sum + Number(i.amount || 0), 0)
                return (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 11.5, color: C.textFaint }}>
                    <span style={{ display: 'inline-block', width: 22, height: 12, borderRadius: 2,
                      background: ADDED_GROUND,
                      boxShadow: `inset 3px 0 0 ${ADDED_EDGE}`,
                      border: '1px solid ' + C.border }} />
                    <span>
                      <strong style={{ color: C.textMuted, fontWeight: 700 }}>{added.length}</strong>
                      {' '}entered here, not submitted by the vendor
                      {' '}· ${total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      {' '}— the amount and invoice number came from us, so no vendor-side record backs them
                    </span>
                  </div>
                )
              })()}
            </div>
            <table style={{ width: '100%', minWidth: 560, borderCollapse: 'collapse', fontSize: 13, marginTop: 12, background: C.cardBg, borderRadius: 10, overflow: 'hidden', border: '1px solid ' + C.border }}>
              <thead>
                <tr>
                  <th style={{ ...TH, width: 26 }}></th>
                  <th style={TH}>Date</th>
                  <th style={TH}>Invoice #</th>
                  <th style={TH}>Description</th>
                  <th style={TH}>Artist</th>
                  <th style={TH}>Song</th>
                  <th style={TH}>Category</th>
                  <th style={TH}>Status</th>
                  <th style={TH}>Paid</th>
                  <th style={TH}>Method</th>
                  <th style={{ ...TH, textAlign: 'right' }}>Amount</th>
                  <th style={{ ...TH, textAlign: 'center' }}>Files</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  // ONE editable-cell renderer for the root row and its split
                  // children. Two copies would drift the moment one of them
                  // gained a control, and the child rows are exactly where a
                  // wrong artist usually hides.
                  const editable = (row, field, opts = {}) => {
                    const key = `${row.id}:${field}`
                    const val = row[field] || ''
                    if (editCell === key) {
                      const done = (v) => saveEntryField(row, field, v)
                      if (field === 'artist') {
                        return (
                          <span onClick={(e) => e.stopPropagation()}>
                            <ArtistSelect value={val} options={roster} autoFocus
                              placeholder="Artist…" onChange={(v) => done(v)}
                              className="w-full border rounded px-1 py-0.5 text-[12px] outline-none" />
                          </span>
                        )
                      }
                      if (field === 'category') {
                        // Type-to-filter, like the artist picker beside it and
                        // the ones on Reports. A native select over ~30
                        // categories — several long and near-identical ("Artist
                        // Expense - Recording" vs "- Legal" vs "- Other") — gives
                        // you scrolling and first-letter jumping, on a table
                        // where you are setting a category row after row.
                        //
                        // CategorySelect, not a bare PickerMenu: it also renders
                        // a stored value the active list no longer offers, which
                        // is real here — expenses.category is free text holding
                        // historical values, and a picker that showed blank would
                        // invite silently recategorizing the row.
                        return (
                          <span onClick={(e) => e.stopPropagation()}>
                            <CategorySelect value={val} kind="expense" autoFocus disabled={editBusy}
                              onChange={(v) => done(v)}
                              className="w-full border rounded px-1 py-0.5 text-[12px] outline-none"
                              style={{ background: C.cardBg, color: C.text, borderColor: C.border }} />
                          </span>
                        )
                      }
                      return (
                        <input autoFocus value={editVal} disabled={editBusy}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setEditVal(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') done(editVal)
                            if (e.key === 'Escape') setEditCell(null)
                          }}
                          onBlur={() => done(editVal)}
                          style={{ width: '100%', border: '1px solid ' + C.border, borderRadius: 4,
                            padding: '2px 4px', fontSize: 12, fontFamily: 'inherit', background: C.cardBg, color: C.text }} />
                      )
                    }
                    return (
                      <span
                        onClick={(e) => {
                          if (!canEditEntries) return
                          e.stopPropagation()
                          setEditVal(val)
                          setEditCell(key)
                        }}
                        title={`Click to edit ${field}`}
                        style={{ cursor: 'text', display: 'inline-block', minWidth: 40,
                          borderBottom: '1px dashed transparent' }}
                        onMouseEnter={(e) => { e.currentTarget.style.borderBottomColor = C.border }}
                        onMouseLeave={(e) => { e.currentTarget.style.borderBottomColor = 'transparent' }}>
                        {val || <span style={{ color: '#ccc' }}>—</span>}
                        {opts.extra}
                      </span>
                    )
                  }
                  // Grouping + filtering are done once above (invChildrenOf /
                  // invVisibleRoots) so the search bar's count and these rows
                  // can never disagree.
                  const childrenOf = invChildrenOf
                  const rows = []
                  // Real invoices first, then the entries the app invented from
                  // bank lines, with a labelled band between them. One loop and
                  // one row renderer — splitting into two tables would have
                  // duplicated the split-family expansion, the file buttons and
                  // the inline edits for no gain.
                  const realRoots = invVisibleRoots.filter((x) => !isBankBorn(x))
                  // A bank-born entry may have come from EITHER account, and
                  // entry_source says 'bank_statement' for both — so one group
                  // labelled "created from bank lines" was quietly mixing BofA
                  // debits with PayPal payments. They are different halves of the
                  // page below and reconcile against different statements, so
                  // they get their own groups here too.
                  //
                  // The account comes off bank_evidence, which the row already
                  // carries. A row whose creating transaction was later dismissed
                  // has no evidence left and cannot be placed, so it stays with
                  // the bank group rather than being invented into a third one.
                  // Straight off the bank activity this page already loaded, so
                  // the band's claim about how many lines exist cannot disagree
                  // with the panel below it.
                  const allActivity = bankAct?.transactions || []
                  const bankLineCount = allActivity.filter((x) => x.account !== 'paypal').length
                  const ppLineCount = allActivity.filter((x) => x.account === 'paypal').length
                  const acctOf = (x) => String(x.bank_evidence?.account || '').toLowerCase()
                  const allBank = invVisibleRoots.filter(isBankBorn)
                  const ppRootsInv = allBank.filter((x) => acctOf(x) === 'paypal')
                  const bankRoots = allBank.filter((x) => acctOf(x) !== 'paypal')
                  const ordered = [...realRoots, ...bankRoots, ...ppRootsInv]
                  // A group's subtotal belongs directly UNDER its own rows.
                  // Stacking all three at the bottom put "Invoiced · 2 items"
                  // below the bank-lines section, two groups away from the rows
                  // it totals — which reads as a subtotal OF that section.
                  const subtotal = (label, roots, key) => {
                    const g = groupTotal(roots)
                    if (!g) return null
                    return (
                      <tr key={key}>
                        <td colSpan={9} style={{ ...TD, textAlign: 'right', color: C.textFaint,
                          fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em',
                          borderTop: '1px solid ' + C.border, background: C.isDark ? '#191c24' : '#fcfcfd' }}>
                          {label}
                          <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 600 }}>
                            {' '}· {roots.length} {roots.length === 1 ? 'item' : 'items'}
                          </span>
                        </td>
                        <td style={{ ...TD, borderTop: '1px solid ' + C.border, background: C.isDark ? '#191c24' : '#fcfcfd' }}></td>
                        <td style={{ ...TD, textAlign: 'right', fontWeight: 800, fontSize: 12.5, color: C.textMuted,
                          fontFamily: 'ui-monospace, monospace',
                          borderTop: '1px solid ' + C.border, background: C.isDark ? '#191c24' : '#fcfcfd' }}
                          title={g.mixed ? `Mixed currencies (${g.currencies}) — shown as the USD equivalent at each invoice's locked rate.` : undefined}>
                          {g.text}
                          {g.usd && (
                            <span style={{ display: 'block', fontWeight: 600, fontSize: 10.5, color: C.textFaint }}>{g.usd}</span>
                          )}
                        </td>
                        <td style={{ ...TD, borderTop: '1px solid ' + C.border, background: C.isDark ? '#191c24' : '#fcfcfd' }}></td>
                      </tr>
                    )
                  }

                  // One band renderer for both boundaries — two copies would
                  // drift the moment one gained a total.
                  // The band is now the fold control for the rows beneath it. Same
                  // markup, plus a chevron and a click target across the whole
                  // width — the note stays, because a folded section still has to
                  // say what it is and why it is separate.
                  const sectionBand = (key, title, count, note, foldKey) => ([
                    <tr key={`${key}-gap`} aria-hidden="true">
                      <td colSpan={12} style={{ padding: 0, height: 14,
                        background: C.isDark ? '#14161d' : '#f1f2f5',
                        borderTop: '1px solid ' + C.border, borderBottom: '1px solid ' + C.border }} />
                    </tr>,
                    <tr key={key}>
                      <td colSpan={12} style={{
                        padding: 0, background: C.isDark ? '#1a1d26' : '#fafafa',
                        borderBottom: '1px solid ' + C.tdBorder,
                      }}>
                        <button
                          onClick={() => foldKey && toggleFold(foldKey)}
                          style={{ width: '100%', textAlign: 'left', background: 'none', border: 'none',
                            fontFamily: 'inherit', cursor: foldKey ? 'pointer' : 'default', padding: '10px 12px',
                            display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}
                          title={foldKey ? (folded[foldKey] ? 'Show these rows' : 'Fold this section away') : undefined}
                        >
                          {foldKey && (
                            <ChevronRight style={{ width: 12, height: 12, color: C.textMuted, flexShrink: 0,
                              transform: folded[foldKey] ? 'none' : 'rotate(90deg)', transition: 'transform .12s' }} />
                          )}
                          <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', color: C.textMuted }}>
                            {title} ({count})
                          </span>
                          <span style={{ fontSize: 11.5, color: C.textFaint }}>{note}</span>
                        </button>
                      </td>
                    </tr>,
                  ])

                  if (realRoots.length) {
                    // ── What this band may claim ────────────────────────────
                    //
                    // It said "a vendor sent a document for each of these" and
                    // that was false twice over. Membership is `!isBankBorn` —
                    // it does not test for a document, and it does not test who
                    // sent one. So the band asserted the vendor submitted every
                    // row while, eight pixels below, the legend and the slate
                    // shading said the opposite about the same rows. On
                    // Christopher Ramos Cosinga (Choty) it labelled 13 rows that
                    // way when the vendor submitted none of them.
                    //
                    // Now it says what the section IS, and reports the split the
                    // shading already encodes — so the colour is decoded where
                    // the eye lands rather than only in the legend above the
                    // table. Counted over `realRoots`, which is exactly the rows
                    // in this section: a band that reduces over anything else is
                    // how a summary and its list come to disagree.
                    const sent = realRoots.filter((x) => x.vendor_submitted).length
                    const keyed = realRoots.length - sent
                    const invNote = keyed === 0
                      ? 'the vendor sent each of these through the submit form'
                      : sent === 0
                        ? 'all entered on our side — no vendor-side record backs the amounts or the invoice numbers'
                        : `${sent} sent by the vendor · ${keyed} entered on our side (shaded)`
                    rows.push(...sectionBand('__inv-band', 'Invoices', realRoots.length,
                      invNote + '  ·  not created from a bank line', 'invoiced'))
                  }
                  ordered.forEach((inv, idx) => {
                    // Which group this row belongs to — ordered is
                    // [...realRoots, ...bankRoots, ...ppRootsInv], so the range
                    // decides it and no row needs to carry a marker.
                    const group = idx < realRoots.length ? 'invoiced'
                      : idx < realRoots.length + bankRoots.length ? 'bankBorn'
                      : 'ppBorn'
                    // PayPal-born entries, after the bank ones.
                    if (ppRootsInv.length && idx === realRoots.length + bankRoots.length) {
                      if (bankRoots.length) rows.push(subtotal('Booked from bank lines', bankRoots, '__sub-bank'))
                      else if (realRoots.length) rows.push(subtotal('Invoiced', realRoots, '__sub-invoiced-b'))
                      rows.push(...sectionBand('__pp-band', 'Created from PayPal lines', ppRootsInv.length,
                        'booked from the PayPal statement — each of these is also funded by a bank pull'
                        + (ppLineCount ? `  ·  ${ppLineCount} PayPal lines in total` : ''), 'ppBorn'))
                    }
                    if (bankRoots.length && idx === realRoots.length) {
                      // Close the invoices group with its own total, then a real
                      // gap. The kinds of row answer different questions and ran
                      // together as one list.
                      if (realRoots.length) rows.push(subtotal('Invoiced', realRoots, '__sub-invoiced'))
                      // Says how many bank lines there are IN TOTAL, not just the
                      // ones we had to invent an entry for. John read "Created
                      // from bank lines (4)" against "Created from PayPal lines
                      // (10)" and concluded there was more PayPal activity than
                      // bank activity, which would be impossible — the truth was
                      // 12 bank lines against 10 PayPal ones, with 8 of the bank
                      // lines matched to real invoices and therefore sitting in
                      // the Invoiced group above. Two labels counting different
                      // things, side by side, invite exactly that reading.
                      rows.push(...sectionBand('__bank-band', 'Created from bank lines', bankRoots.length,
                        'no invoice behind these — the app made an entry from the bank descriptor. Attach the real invoice from Bank Activity below.'
                        + (bankLineCount > bankRoots.length
                          ? `  ·  ${bankLineCount} bank lines in total for this vendor; the other ${bankLineCount - bankRoots.length} are matched to invoices above.`
                          : ''), 'bankBorn'))
                    }
                    const children = childrenOf[inv.id] || []
                    const isParent = children.length > 0
                    const isExpanded = expandedSplits.has(inv.id)
                    const totalAmount = isParent ? children.reduce((s, c) => s + parseFloat(c.amount || 0), parseFloat(inv.amount || 0)) : parseFloat(inv.amount || 0)

                    // A bank-born row carries no invoice number, no file and a
                    // raw descriptor, so among real invoices it reads as a broken
                    // one. A faint ground says which group a row is in without
                    // scrolling back to the band that introduced it.
                    // WHERE THIS INVOICE CAME FROM, on the row itself.
                    //
                    // John: an item added here should carry a hue. Two very
                    // different things sit in this table under identical styling —
                    // an invoice the VENDOR sent through the submit form, and one
                    // somebody keyed in on our side. The second is the one worth
                    // a second look: nobody outside the company vouched for it.
                    //
                    // `vendor_submitted` is the honest test and it works on old
                    // rows, which `entry_source` does not — that column is NULL on
                    // 1,270 live entries because it post-dates them, so it cannot
                    // tell a hand-entered invoice from a vendor-submitted one.
                    // Strega: 19 submitted, 7 entered here.
                    //
                    // Bank-born rows keep their existing paler ground and are NOT
                    // re-tinted: they already sit under their own section band, and
                    // saying "entered here" about a row the app invented from a
                    // statement would be a lie.
                    const addedHere = !isBankBorn(inv) && !inv.vendor_submitted
                    const bornBg = isBankBorn(inv)
                      ? (C.isDark ? '#191c24' : '#fbfbfc')
                      : addedHere ? ADDED_GROUND
                      : C.rowBg
                    // Folded: the band and the subtotal stay, the rows go. A
                    // section that vanishes entirely would take its own total
                    // with it and the page would stop adding up.
                    if (folded[group]) return
                    rows.push(
                      <tr
                        key={inv.id}
                        style={{ background: bornBg, cursor: isParent ? 'pointer' : undefined }}
                        onMouseEnter={e => e.currentTarget.style.background = C.rowHover}
                        onMouseLeave={e => e.currentTarget.style.background = bornBg}
                        onClick={isParent ? () => setExpandedSplits(prev => { const n = new Set(prev); n.has(inv.id) ? n.delete(inv.id) : n.add(inv.id); return n }) : undefined}
                      >
                        {/* EVERY row gets a box now. It used to be only the ones
                            with a bank line, because unmatch was the only bulk
                            action and a checkbox leading to a refusal is worse
                            than no checkbox. Selection now also recategorizes and
                            flags, which every row can do — so restricting the box
                            meant most of the table could not be acted on at all.
                            Unmatch still applies to the subset with a bank line,
                            and the bar says how many that is. */}
                        <td style={{ ...TD, paddingRight: 0 }} onClick={(e) => e.stopPropagation()}>
                          {true ? (
                            <input type="checkbox" checked={invSel.has(inv.id)} disabled={attachBusy}
                              onChange={() => setInvSel((prev) => {
                                const n = new Set(prev)
                                if (n.has(inv.id)) n.delete(inv.id); else n.add(inv.id)
                                return n
                              })}
                              style={{ cursor: attachBusy ? 'default' : 'pointer' }} />
                          ) : null}
                        </td>
                        {/* A 3px edge rather than a badge or opacity — the same
                            device the answered rows in Bank Activity use, so the
                            page has ONE way of saying "this row is a different
                            kind of thing". Slate, not amber: provenance is not an
                            alert. */}
                        <td style={{ ...TD, color: '#9ca3af', fontWeight: 600, whiteSpace: 'nowrap',
                          boxShadow: addedHere ? `inset 3px 0 0 ${ADDED_EDGE}` : undefined }}
                          title={addedHere
                            ? `Entered here${inv.entry_source ? ` by ${inv.entry_source.replace(/_/g, ' ')}` : ''}, not submitted by the vendor — the amount and invoice number came from us, so there is no vendor-side record backing them.`
                            : undefined}>
                          {fmtDate(inv.invoice_date)}
                        </td>
                        <td style={{ ...TD, fontWeight: 600, whiteSpace: 'nowrap' }}>
                          {inv.invoice_number || '—'}
                          {/* Filed under the wrong vendor? Moves THIS entry only.
                              Not a merge — merging says two companies are one and
                              renames everything; this says one invoice was
                              mis-filed. */}
                          {moveFor === `inv:${inv.id}` ? (
                            <span style={{ marginLeft: 8 }}>{movePicker((target) => moveInvoiceTo(inv, target))}</span>
                          ) : (
                            <button onClick={(e) => { e.stopPropagation(); setMoveFor(`inv:${inv.id}`); setMoveQ(''); setMoveOpts([]) }}
                              title="Wrong vendor? Move just this entry to another one."
                              style={{ background: 'none', border: 'none', padding: '0 0 0 6px', cursor: 'pointer',
                                color: 'transparent', fontSize: 10, fontWeight: 700, fontFamily: 'inherit' }}
                              onMouseEnter={(e) => { e.currentTarget.style.color = C.textFaint }}
                              onMouseLeave={(e) => { e.currentTarget.style.color = 'transparent' }}>
                              move
                            </button>
                          )}
                        </td>
                        <td style={{ ...TD, color: '#777', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {isParent && <span style={{ color: '#a5b4fc', fontSize: 10, marginRight: 5 }}>{isExpanded ? '▼' : '▶'}</span>}
                          {inv.description || '—'}
                          {isParent && <span style={{ background: '#dbeafe', color: '#1d4ed8', fontSize: 10, fontWeight: 800, padding: '1px 6px', borderRadius: 10, marginLeft: 6 }}>{children.length + 1} splits</span>}
                          {/* WHY it was flagged, in the widest cell on the row.
                              Opens only after the flag itself is saved, so
                              abandoning the note still leaves the row flagged —
                              the flag is the point, the reason is a nicety. */}
                          {flagNoteFor === inv.id && (
                            <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex', gap: 4, marginLeft: 8 }}>
                              <input autoFocus value={flagNote} placeholder="why? (optional)"
                                onChange={(e) => setFlagNote(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') saveFlagNote(inv)
                                  if (e.key === 'Escape') setFlagNoteFor(null)
                                }}
                                style={{ border: '1px solid ' + C.border, borderRadius: 6, padding: '1px 6px',
                                  fontSize: 11, fontFamily: 'inherit', background: C.cardBg, color: C.text, width: 190 }} />
                              <button onClick={() => saveFlagNote(inv)}
                                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                                  color: C.textMuted, fontSize: 10.5, fontWeight: 800, fontFamily: 'inherit' }}>save</button>
                            </span>
                          )}
                          {/* The reason, once it exists — otherwise it is only
                              readable by hovering, on a page where hovering is
                              how you discover things rather than how you read them. */}
                          {inv.flagged && inv.flag_reason && flagNoteFor !== inv.id && (
                            <span title={`Flagged${inv.flagged_by_name ? ` by ${inv.flagged_by_name}` : ''}`}
                              style={{ color: '#e11d48', fontSize: 10.5, fontWeight: 700, marginLeft: 6 }}>
                              ⚑ {inv.flag_reason}
                            </span>
                          )}
                        </td>
                        <td style={{ ...TD, color: '#555', maxWidth: 140 }} title={inv.artist || ''}>
                          {editable(inv, 'artist', { extra: isParent && children.some(c => (c.artist || '').trim().toLowerCase() !== (inv.artist || '').trim().toLowerCase())
                            ? <span style={{ color: '#a5b4fc', fontSize: 10, marginLeft: 4 }}>+{children.length}</span> : null })}
                        </td>
                        <td style={{ ...TD, color: '#555', maxWidth: 160 }} title={inv.song || ''}>
                          {editable(inv, 'song')}
                        </td>
                        <td style={{ ...TD, color: '#555' }}>{editable(inv, 'category')}</td>
                        <td style={TD}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                            <span style={{ ...badgeBase, ...(PAID_BADGE[inv.payment_status] || PAID_BADGE.Unpaid) }}>
                              {inv.payment_status || 'Unpaid'}
                            </span>
                            {/* Pairs with the Bank Activity section below —
                                per-invoice bank confirmation, not just the
                                vendor-level 'Bank − invoiced' variance. */}
                            <BankEvidenceDot row={inv} />
                          </span>
                        </td>
                        <td style={{ ...TD, color: '#9ca3af', fontWeight: 600, whiteSpace: 'nowrap' }}>
                          {inv.payment_status === 'Paid' ? fmtDate(inv.payment_date) : '—'}
                        </td>
                        <td style={TD}>
                          {inv.payment_method ? (
                            <span style={{ ...badgeBase, ...(METHOD_BADGE[inv.payment_method] || { bg: C.badgeNeutralBg, color: C.text }) }}>{inv.payment_method}</span>
                          ) : <span style={{ color: '#ccc' }}>—</span>}
                        </td>
                        <td style={{ ...TD, textAlign: 'right', fontWeight: 900, color: RED, whiteSpace: 'nowrap' }}>
                          {isParent && !isExpanded ? fmt(totalAmount, inv.currency) : fmt(inv.amount, inv.currency)}
                        </td>
                        <td style={{ ...TD, textAlign: 'center' }}>
                          <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
                            {inv.has_invoice && <button onClick={e => { e.stopPropagation(); setPreviewFile({ url: `/api/bk/entries/${inv.id}/file/invoice?token=${localStorage.getItem('token')}`, filename: `Invoice-${inv.invoice_number || inv.id}` }) }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#2563eb', fontSize: 11, fontWeight: 600, fontFamily: 'inherit' }}>Inv</button>}
                            {inv.has_proof && <button onClick={e => { e.stopPropagation(); setPreviewFile({ url: `/api/bk/entries/${inv.id}/file/proof?token=${localStorage.getItem('token')}`, filename: `Proof-${inv.invoice_number || inv.id}` }) }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#16a34a', fontSize: 11, fontWeight: 600, fontFamily: 'inherit' }}>Proof</button>}
                            {(inv.has_w9 || inv.w9_entry_id) && <button onClick={e => { e.stopPropagation(); setPreviewFile({ url: `/api/bk/entries/${inv.w9_entry_id || inv.id}/file/w9?token=${localStorage.getItem('token')}`, filename: `W9-${vendorDetail.payee}` }) }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ea580c', fontSize: 11, fontWeight: 600, fontFamily: 'inherit' }}>W9</button>}
                            {!inv.has_invoice && !inv.has_proof && !inv.has_w9 && <span style={{ color: '#ccc', fontSize: 11 }}>—</span>}
                            {/* In the FILES cell deliberately: it is the row's
                                existing action corner, and adding a column would
                                have meant re-counting the colSpan on three
                                subtotal rows and two section bands. */}
                            {flagButton('inv', inv)}
                            {/* The undo, on the row where the wrong match is
                                noticed. It lived only on the bank line before,
                                so seeing it here meant going to find that row. */}
                            {inv.bank_evidence?.txn_id && canSeeBank && (
                              <button onClick={(e) => { e.stopPropagation(); unmatchInvoice(inv) }} disabled={attachBusy}
                                title={`Matched to the ${fmtDate(inv.bank_evidence.txn_date)} bank line (#${inv.bank_evidence.txn_id}). Unmatch it.`}
                                style={{ background: 'none', border: 'none', cursor: attachBusy ? 'default' : 'pointer',
                                  color: C.textFaint, fontSize: 11, fontWeight: 600, fontFamily: 'inherit', padding: 0 }}>
                                unmatch
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                    // Render children if expanded
                    if (isParent && isExpanded) {
                      children.forEach(child => {
                        rows.push(
                          <tr key={child.id} style={{ background: C.isDark ? '#1a1d28' : '#f8f8ff' }}>
                            <td style={{ ...TD }}></td>
                            <td style={{ ...TD, color: '#9ca3af', fontSize: 12 }}></td>
                            <td style={{ ...TD }}></td>
                            <td style={{ ...TD, color: '#777', paddingLeft: 28 }}>
                              <span style={{ color: '#a5b4fc', fontSize: 11, marginRight: 4 }}>↳</span>
                              {child.description || '—'}
                            </td>
                            <td style={{ ...TD, color: '#777', maxWidth: 140 }} title={child.artist || ''}>
                              {editable(child, 'artist')}
                            </td>
                            <td style={{ ...TD, color: '#777', maxWidth: 160 }} title={child.song || ''}>
                              {editable(child, 'song')}
                            </td>
                            <td style={{ ...TD, color: '#555' }}>{editable(child, 'category')}</td>
                            {/* Status/Paid/Method are family-cascaded — parent
                                shows them; children left blank to reduce visual noise. */}
                            <td style={TD}></td>
                            <td style={TD}></td>
                            <td style={TD}></td>
                            <td style={{ ...TD, textAlign: 'right', fontWeight: 700, color: RED, fontSize: 12 }}>{fmt(child.amount, child.currency)}</td>
                            <td style={{ ...TD }}></td>
                          </tr>
                        )
                      })
                    }
                  })
                  return rows
                })()}
              </tbody>
              {/* Totals. Two subtotals only when both kinds are present, because
                  they answer different questions: what this vendor has INVOICED
                  us for, versus what the app booked off bank descriptors with no
                  invoice behind it. One number covering both would hide exactly
                  the gap this table was split to show. */}
              {invVisibleRoots.length > 0 && (() => {
                // The SAME split as the body above, or the footer totals a
                // grouping the rows are not in.
                const acct = (x) => String(x.bank_evidence?.account || '').toLowerCase()
                const realRoots = invVisibleRoots.filter((x) => !isBankBorn(x))
                const allBankF = invVisibleRoots.filter(isBankBorn)
                const ppRoots = allBankF.filter((x) => acct(x) === 'paypal')
                const bankRoots = allBankF.filter((x) => acct(x) !== 'paypal')
                const line = (label, roots, opts = {}) => {
                  const g = groupTotal(roots)
                  if (!g) return null
                  return (
                    <tr key={label} style={{
                      borderTop: (opts.strong ? '2px solid ' + C.textMuted : '1px solid ' + C.border),
                      background: opts.strong ? (C.isDark ? '#1c2030' : '#f6f7f9') : 'transparent',
                    }}>
                      <td colSpan={9} style={{ ...TD, textAlign: 'right', color: C.textFaint,
                        fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        {label}
                        <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 600, color: C.textFaint }}>
                          {' '}· {roots.length} {roots.length === 1 ? 'item' : 'items'}
                        </span>
                      </td>
                      <td style={TD}></td>
                      <td style={{ ...TD, textAlign: 'right', fontWeight: 800, fontSize: opts.strong ? 13 : 12.5,
                        color: opts.strong ? C.text : C.textMuted, fontFamily: 'ui-monospace, monospace' }}
                        title={g.mixed ? `Mixed currencies (${g.currencies}) — shown as the USD equivalent at each invoice's locked rate.` : undefined}>
                        {g.text}
                        {g.usd && (
                          <span style={{ display: 'block', fontWeight: 600, fontSize: 10.5, color: C.textFaint }}
                            title={`${g.currencies} converted at each invoice's locked rate.`}>
                            {g.usd}
                          </span>
                        )}
                      </td>
                      <td style={TD}></td>
                    </tr>
                  )
                }
                return (
                  <tfoot>
                    {/* Only the LAST group's subtotal lives here — the earlier
                        ones sit directly under their own rows. A subtotal two
                        sections away from what it totals reads as belonging to
                        whatever it happens to sit under. */}
                    {ppRoots.length > 0
                      ? line('Booked from PayPal lines', ppRoots)
                      : (bankRoots.length > 0 && realRoots.length > 0 && line('Booked from bank lines', bankRoots))}
                    {line('Total', invVisibleRoots, { strong: true })}
                    {invQ.trim() && (
                      <tr>
                        <td colSpan={12} style={{ ...TD, textAlign: 'right', color: C.textFaint, fontSize: 11 }}>
                          {/* A filtered total is not the vendor's total, and a
                              footer that didn't say so would be read as one. */}
                          totals cover the {invVisibleRoots.length} row{invVisibleRoots.length === 1 ? '' : 's'} matching “{invQ.trim()}”
                        </td>
                      </tr>
                    )}
                  </tfoot>
                )
              })()}
            </table>
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: '#999', fontSize: 14 }}>
              No invoices for this vendor.
            </div>
          )}
        </div>
        )}

        {/* Bank Activity — the statement side of this vendor (Phase 2 of the
            vendors consolidation). Hidden when there's no bank presence or
            for roles without statements access. */}
        {vendorTab === 'activity' && bankAct && (
          <div style={{ margin: '16px 16px 24px', background: C.cardBg, border: '1px solid ' + C.border, borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid ' + C.border, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <button
                onClick={() => toggleFold('bankActivity')}
                title={folded.bankActivity ? 'Show the bank lines' : 'Fold the bank lines away'}
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit',
                  display: 'flex', alignItems: 'center', gap: 5 }}
              >
                <ChevronRight style={{ width: 12, height: 12, color: C.textMuted,
                  transform: folded.bankActivity ? 'none' : 'rotate(90deg)', transition: 'transform .12s' }} />
                <span style={{ fontSize: 13, fontWeight: 800, color: C.text }}>Bank Activity</span>
              </button>
              <span style={{ fontSize: 12, color: C.textFaint }}>
                {/* Counted the way the page is DIVIDED. The summary said 21 while
                    the list held 24 and the PayPal section held 7 of them — three
                    numbers for one vendor, none of them wrong on its own. */}
                {bankRowsOnly.length} bank line{bankRowsOnly.length === 1 ? '' : 's'}
                {ppRows.length > 0 && ` · ${ppRows.length} PayPal`}
                {' · '}{fmt(bankAct.summary.total)}
                {bankAct.summary.open_n > 0 && <span style={{ color: RED, fontWeight: 700 }}> · {fmt(bankAct.summary.open_total)} open ({bankAct.summary.open_n})</span>}
                {bankAct.summary.learned_category && ` · books as ${bankAct.summary.learned_category}`}
              </span>
              {/* The actionable number. NOT the count of unmatched bank lines:
                  SPOTIFY has 151 booked lines against 2 unattached invoices, and
                  a header reading 151 would send someone to work rows that need a
                  no-invoice rule rather than a pairing. */}
              {unattached.length > 0 && (
                <span style={{ fontSize: 11, fontWeight: 800, color: '#b45309', background: C.isDark ? '#3a2f1a' : '#fffbeb',
                  border: '1px solid ' + (C.isDark ? '#5a4a22' : '#fde68a'), padding: '2px 8px', borderRadius: 4 }}
                  title="Marked Paid, a statement covering that date is on file, and no bank line is attached — attach them from the rows below.">
                  {unattached.length} invoice{unattached.length === 1 ? '' : 's'} with no bank line
                </span>
              )}
              {/* The other half of the debt: booked, categorized, and naming
                  nobody. Counted from the rows this panel LISTS, so it agrees
                  with the directory chip that sent you here. */}
              {needsArtistRows.length > 0 && (
                <span style={{ fontSize: 11, fontWeight: 800, color: '#6d28d9', background: C.isDark ? '#241f3a' : '#f5f3ff',
                  border: '1px solid ' + (C.isDark ? '#4c3f7a' : '#ddd6fe'), padding: '2px 8px', borderRadius: 4 }}
                  title="Booked from a bank line, so there is no invoice saying who the spend was for — and no artist on the entry. These are what leaves Spend by Artist reporting a quarter of actual spend.">
                  {needsArtistRows.length} need{needsArtistRows.length === 1 ? 's' : ''} an artist
                </span>
              )}
              {/* The row-level actions this panel deliberately does NOT carry —
                  dismiss, split across categories, currency correction — still
                  live on Bank Matching, so there is one link to them rather than
                  a second half-copy of that page here. It points at
                  /bk/bank-matching, which is where matching moved; several older
                  links elsewhere still say /bk/statements. */}
              <button onClick={() => navigate(`/bk/bank-matching?q=${encodeURIComponent((bankAct.payees[0]?.name) || vendorDetail.payee || '')}`)}
                title="Open these lines on Bank Matching — for dismissing, splitting across categories or fixing a currency"
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: C.textFaint,
                  fontSize: 11, fontWeight: 700, fontFamily: 'inherit' }}>
                more actions →
              </button>
              <span style={{ marginLeft: 'auto', fontSize: 11, color: C.textFaint }}>
                bank payees:{' '}
                {bankAct.payees.map((p, i) => (
                  <span key={p.key}>
                    {i > 0 ? ', ' : ''}
                    <span style={{ fontWeight: 700, color: p.explicit ? '#059669' : '#d97706' }}
                      title={p.explicit ? 'Explicitly linked' : 'Matched by name/inference — confirm from the Vendors directory'}>
                      {p.name}{p.explicit ? ' ✦' : ''}
                    </span>
                    {/* On the wrong company? Repointing the payee map moves every
                        line from this descriptor, which is what the map is for —
                        the confirm says so rather than implying one row moves. */}
                    {moveFor === `bank:${p.name}` ? movePicker((target) => moveBankPayeeTo(p.name, target)) : (
                      <button onClick={() => { setMoveFor(`bank:${p.name}`); setMoveQ(''); setMoveOpts([]) }}
                        title={`"${p.name}" belongs to another vendor? Move every line from this bank descriptor.`}
                        style={{ background: 'none', border: 'none', padding: '0 0 0 4px', cursor: 'pointer',
                          color: C.textFaint, fontSize: 10, fontWeight: 700, fontFamily: 'inherit' }}>
                        move
                      </button>
                    )}
                  </span>
                ))}
              </span>
            </div>
            {/* Answer several at once. Select-all covers the lines that can be
                answered, not every row — a matched line has its invoice. */}
            {(() => {
              // bankRowsOnly, not every row: PayPal payments now live in their
              // own section with no checkbox, and a select-all that reaches rows
              // you cannot see is how a bulk action does more than it says.
              // Both directions. A selection used to offer one action and hide
              // itself once every row was answered, so a vendor whose lines were
              // ALL marked had no selection, no button and no explanation — it
              // read as the control being broken rather than the work being done.
              const selectable = bankRowsOnly.filter((t) => t.status === 'open' || t.status === 'booked' || t.status === 'matched')
              const waiting = selectable.filter((t) => t.status !== 'matched' && !t.no_invoice_expected)
              const marked = selectable.filter((t) => t.status !== 'matched' && t.no_invoice_expected)
              // The two undos, counted apart: unmatching frees an invoice,
              // unbooking deletes an entry the app invented.
              const selMatched = [...lineSel].filter((id) => bankRowsOnly.some((t) => t.id === id && t.status === 'matched'))
              const selBooked = [...lineSel].filter((id) => bankRowsOnly.some((t) => t.id === id && t.status === 'booked'))
              if (selectable.length < 2) return null
              const target = waiting.length ? waiting : marked
              const allSel = target.length > 0 && target.every((t) => lineSel.has(t.id))
              const selWaiting = [...lineSel].filter((id) => waiting.some((t) => t.id === id))
              const selMarked = [...lineSel].filter((id) => marked.some((t) => t.id === id))
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                  padding: '8px 16px', borderBottom: '1px solid ' + C.tdBorder, background: C.isDark ? '#1a1d26' : '#fafafa' }}>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: C.textMuted, cursor: 'pointer', fontWeight: 600 }}>
                    <input type="checkbox" checked={allSel} disabled={attachBusy}
                      onChange={() => setLineSel(allSel ? new Set() : new Set(target.map((t) => t.id)))} />
                    Select all {target.length} {waiting.length ? 'waiting' : 'marked'}
                  </label>
                  <span style={{ fontSize: 12, color: C.textFaint }}>
                    {lineSel.size} selected
                    {/* Says the work is DONE rather than leaving an empty
                        control to be read as a fault. */}
                    {!waiting.length && marked.length > 0 && ` · all ${marked.length} are marked as never needing an invoice`}
                    {waiting.length > 0 && marked.length > 0 && ` · ${marked.length} already marked`}
                  </span>
                  {/* Several payments, one invoice. Offered from two upwards,
                      because one payment already has its own attach control. */}
                  {selWaiting.length > 1 && (
                    <button onClick={() => { setAttachErr(''); setMultiFor(multiFor ? null : selWaiting) }} disabled={attachBusy}
                      title="These payments settle ONE invoice between them — a deposit and a balance, or a wire split across two days."
                      style={{ marginLeft: 'auto', background: '#059669', border: 'none', borderRadius: 6,
                        cursor: attachBusy ? 'default' : 'pointer', color: '#fff', fontSize: 11.5,
                        fontWeight: 800, fontFamily: 'inherit', padding: '4px 10px', opacity: attachBusy ? 0.5 : 1 }}>
                      {multiFor ? 'cancel' : `Attach ${selWaiting.length} to one invoice`}
                    </button>
                  )}
                  {selWaiting.length > 0 && (
                    <button onClick={() => bulkNoInvoiceLines(selWaiting)} disabled={attachBusy}
                      title="These payments never had an invoice — stops them being asked about. Reversible from this page."
                      style={{ marginLeft: 'auto', background: 'none', border: '1px solid ' + C.border, borderRadius: 6,
                        cursor: attachBusy ? 'default' : 'pointer', color: C.textMuted, fontSize: 11.5,
                        fontWeight: 700, fontFamily: 'inherit', padding: '4px 10px', opacity: attachBusy ? 0.5 : 1 }}>
                      No invoice needed · {selWaiting.length}
                    </button>
                  )}
                  {selMatched.length > 0 && (
                    <button onClick={() => bulkUnmatch(selMatched)} disabled={attachBusy}
                      title="Detach these from their invoices. The invoices go back to waiting for a bank line; a row that displaced a booking gets it back."
                      style={{ marginLeft: 'auto', background: 'none', border: '1px solid ' + C.border, borderRadius: 6,
                        cursor: attachBusy ? 'default' : 'pointer', color: C.textMuted, fontSize: 11.5,
                        fontWeight: 700, fontFamily: 'inherit', padding: '4px 10px', opacity: attachBusy ? 0.5 : 1 }}>
                      Unmatch · {selMatched.length}
                    </button>
                  )}
                  {selBooked.length > 0 && (
                    <button onClick={() => bulkUnbookLines(selBooked)} disabled={attachBusy}
                      title="Remove the entry the app invented for each of these and reopen the row."
                      style={{ background: 'none', border: '1px solid ' + C.border, borderRadius: 6,
                        cursor: attachBusy ? 'default' : 'pointer', color: C.textMuted, fontSize: 11.5,
                        fontWeight: 700, fontFamily: 'inherit', padding: '4px 10px', opacity: attachBusy ? 0.5 : 1 }}>
                      Unbook · {selBooked.length}
                    </button>
                  )}
                  {/* Every selected line, whatever its state. Where a payment
                      is FILED is independent of whether it has an invoice, so
                      unlike the buttons around it this one does not care. */}
                  {lineSel.size > 0 && (
                    moveFor === 'bulk'
                      ? movePicker((target, o) => bulkMoveLines([...lineSel], target, o))
                      : (
                        <button onClick={() => { setAttachErr(''); setMoveFor('bulk'); setMoveQ(''); setMoveOpts([]) }}
                          disabled={attachBusy}
                          title="File these payments under a different vendor. Only these lines move; their bank descriptors are unchanged."
                          style={{ background: 'none', border: '1px solid ' + C.border, borderRadius: 6,
                            cursor: attachBusy ? 'default' : 'pointer', color: C.textMuted, fontSize: 11.5,
                            fontWeight: 700, fontFamily: 'inherit', padding: '4px 10px', opacity: attachBusy ? 0.5 : 1 }}>
                          Move to vendor · {lineSel.size}
                        </button>
                      )
                  )}
                  {selMarked.length > 0 && (
                    <button onClick={() => bulkExpectInvoice(selMarked)} disabled={attachBusy}
                      title="Put these back in the queue — they will be asked for an invoice again."
                      style={{ marginLeft: selWaiting.length ? 0 : 'auto', background: 'none',
                        border: '1px solid ' + C.border, borderRadius: 6,
                        cursor: attachBusy ? 'default' : 'pointer', color: C.textMuted, fontSize: 11.5,
                        fontWeight: 700, fontFamily: 'inherit', padding: '4px 10px', opacity: attachBusy ? 0.5 : 1 }}>
                      Expect an invoice · {selMarked.length}
                    </button>
                  )}
                </div>
              )
            })()}
            {/* The shared picker, measured against the COMBINED total — the
                question on an instalment is "do these two add up to it", which
                is the same question the picker already answers for one payment
                against several invoices. */}
            {multiFor && (() => {
              const rows = bankRowsOnly.filter((t) => multiFor.includes(t.id))
              const sum = rows.reduce((n, t) => n + Number(t.usd ?? t.amount ?? 0), 0)
              return (
                <div style={{ padding: '10px 16px', borderBottom: '1px solid ' + C.tdBorder, background: C.isDark ? '#16241d' : '#f0fdf4' }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 6 }}>
                    {rows.length} payments · {fmt(sum)} — pick the ONE invoice they settle between them
                  </div>
                  <div style={{ fontSize: 11, color: C.textFaint, marginBottom: 8 }}>
                    {rows.map((t) => `${fmtDate(t.txn_date)} ${fmt(t.amount, t.currency)}`).join('  +  ')}
                  </div>
                  <InvoiceAttachPicker
                    candidates={attachable}
                    lineUsd={sum}
                    lineDate={rows[0]?.txn_date}
                    busy={attachBusy}
                    dark={C}
                    onPreview={setPreviewFile}
                    onAttach={(invIds) => attachManyToOne(multiFor, invIds[0])}
                    emptyText="No invoice of this vendor's is waiting for a bank line."
                  />
                </div>
              )
            })()}
            {/* WHO the spend was for — the answer a booked line cannot give.
                Two ways to close it, and the second is the dismissal John asked
                for: not every payment is an artist's. Both write a RULE, so a
                future statement from this vendor is answered automatically, and
                both are undone by deleting that rule on /bk/rules. */}
            {/* Shown for a SELECTION as well as for unanswered rows. Attributing
                was only reachable while something still lacked an artist, so
                correcting one that was already set — the wrong artist, or a
                rule's default applied too widely — meant leaving for the ledger. */}
            {(needsArtistRows.length > 0 || lineSel.size > 0) && canSeeBank && (
              <div style={{ padding: '10px 16px', borderBottom: '1px solid ' + C.tdBorder,
                background: C.isDark ? '#211d33' : '#f5f3ff', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: C.text }}>
                  {needsArtistRows.length === 0
                    ? `${lineSel.size} selected payment${lineSel.size === 1 ? '' : 's'}`
                    : `${needsArtistRows.length} booked payment${needsArtistRows.length === 1 ? '' : 's'} name no artist`}
                  {/* WHERE they are. This count spans both statements, and when
                      every one of them sits in the PayPal section the bank list
                      below shows none — which reads as the count being wrong. */}
                  {(() => {
                    if (!needsArtistRows.length) return null
                    const onPp = needsArtistRows.filter((t) => t.account === 'paypal').length
                    const onBank = needsArtistRows.length - onPp
                    if (!onPp || !onBank) {
                      return (
                        <span style={{ fontWeight: 500, color: C.textFaint }}>
                          {' '}· {onPp ? 'in PayPal activity below' : 'in the bank list below'}
                        </span>
                      )
                    }
                    return (
                      <span style={{ fontWeight: 500, color: C.textFaint }}>
                        {' '}· {onBank} in the bank list, {onPp} in PayPal activity
                      </span>
                    )
                  })()}
                  <span style={{ fontWeight: 500, color: C.textFaint }}>
                    {/* Whatever the headline is counting — otherwise a
                        selection-only band reads "$0.00". */}
                    {' · '}{fmt((needsArtistRows.length === 0
                      ? (bankAct?.transactions || []).filter((t) => lineSel.has(t.id))
                      : needsArtistRows).reduce((sum, t) => sum + Math.abs(Number(t.usd) || 0), 0))}
                  </span>
                </span>
                <ArtistSelect
                  value={artistPick}
                  options={roster}
                  disabled={artistBusy}
                  placeholder="Attribute to…"
                  onChange={(v) => setArtistPick(v)}
                  className="w-40 border rounded-lg px-2 py-1 text-[12px] outline-none"
                />
                {needsArtistRows.length > 0 && (
                <button onClick={() => answerArtist({ overhead: false })} disabled={artistBusy || !artistPick.trim()}
                  title="Writes this artist onto these entries, and remembers the answer for this vendor's future statements."
                  style={{ background: '#6d28d9', border: 'none', borderRadius: 6, color: '#fff', fontSize: 11.5,
                    fontWeight: 800, fontFamily: 'inherit', padding: '5px 12px',
                    cursor: (artistBusy || !artistPick.trim()) ? 'default' : 'pointer',
                    opacity: (artistBusy || !artistPick.trim()) ? 0.5 : 1 }}>
                  {artistBusy ? 'applying…' : `Attribute all ${needsArtistRows.length}`}
                </button>
                )}
                {/* When rows are ticked, THAT is the answer being given. The
                    all-N button wrote a vendor-wide rule over a selection it
                    ignored, so ticking two of five and pressing it attributed
                    five and taught the vendor the wrong default. */}
                {lineSel.size > 0 && (
                  <button onClick={() => attributeSelected([...lineSel])}
                    disabled={artistBusy || !artistPick.trim()}
                    title={`Write this artist onto the ${lineSel.size} ticked payment${lineSel.size === 1 ? '' : 's'} only. No rule — this vendor's other payments keep whatever they have.`}
                    style={{ background: '#4c1d95', border: 'none', borderRadius: 6, color: '#fff', fontSize: 11.5,
                      fontWeight: 800, fontFamily: 'inherit', padding: '5px 12px',
                      cursor: (artistBusy || !artistPick.trim()) ? 'default' : 'pointer',
                      opacity: (artistBusy || !artistPick.trim()) ? 0.5 : 1 }}>
                    {artistBusy ? 'applying…' : `Attribute ${lineSel.size} selected`}
                  </button>
                )}
                {needsArtistRows.length > 0 && (
                <button onClick={() => {
                  if (!window.confirm(`Mark this vendor's spend as overhead?\n\n${needsArtistRows.length} payment${needsArtistRows.length === 1 ? '' : 's'} stop being asked for an artist. Nothing is written to the ledger — the entries keep no artist on purpose — and deleting the rule on Rules brings them back.`)) return
                  answerArtist({ overhead: true })
                }} disabled={artistBusy}
                  title="Rent, bank fees, payroll, software: real spend that isn't any artist's. Nothing is written to the ledger; the rows just stop being asked about."
                  style={{ background: 'none', border: '1px solid ' + C.border, borderRadius: 6, color: C.textMuted,
                    fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit', padding: '5px 10px',
                    cursor: artistBusy ? 'default' : 'pointer', opacity: artistBusy ? 0.5 : 1 }}>
                  Not artist spend
                </button>
                )}
                <span style={{ fontSize: 11, color: C.textFaint }}>
                  {lineSel.size > 0
                    ? 'the all-N and overhead answers write a rule · the selected one does not'
                    : 'reversible from '}
                  {lineSel.size === 0 && <a href="/bk/rules" style={{ color: 'inherit', textDecoration: 'underline' }}>Rules</a>}
                </span>
              </div>
            )}
            {/* The answer that was given, and the way back. Once a vendor was
                marked overhead the band vanished, so the page showed no sign the
                answer existed — and the only undo was another page. */}
            {bankAct.artist_rule && canSeeBank && needsArtistRows.length === 0 && (
              <div style={{ padding: '8px 16px', borderBottom: '1px solid ' + C.tdBorder,
                background: C.isDark ? '#211d33' : '#f5f3ff', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: C.textMuted }}>
                  {bankAct.artist_rule.is_overhead
                    ? 'This vendor’s spend is marked as overhead — its payments are not asked for an artist.'
                    : `This vendor’s spend is attributed to ${bankAct.artist_rule.artist}.`}
                </span>
                <button onClick={() => undoArtistRule(bankAct.artist_rule)} disabled={artistBusy}
                  title={bankAct.artist_rule.is_overhead
                    ? 'Bring these payments back into the needs-an-artist queue. Nothing was written to the ledger, so there is nothing else to reverse.'
                    : 'Stop applying this rule to future statements. Artists already written stay on their entries.'}
                  style={{ background: 'none', border: '1px solid ' + C.border, borderRadius: 6, color: C.textMuted,
                    fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit', padding: '4px 10px',
                    cursor: artistBusy ? 'default' : 'pointer', opacity: artistBusy ? 0.5 : 1 }}>
                  {bankAct.artist_rule.is_overhead ? 'Require an artist again' : 'Remove this rule'}
                </button>
              </div>
            )}
            {artistNote && (
              <div style={{ padding: '8px 16px', background: C.isDark ? '#14301f' : '#ecfdf5', borderBottom: '1px solid ' + C.tdBorder, fontSize: 12, color: C.text }}>
                {artistNote}
              </div>
            )}
            {attachErr && (
              <div style={{ padding: '8px 16px', background: C.isDark ? '#3b1f24' : '#fff1f2', borderBottom: '1px solid ' + C.tdBorder, fontSize: 12, color: C.text }}>
                {attachErr}
                {/* The one refusal that is a question, not a verdict. Money can
                    legitimately leave before an invoice exists — a retainer, an
                    advance — and only the person looking at it knows. Recorded as
                    a prepayment when taken, so the pairing stays explainable and
                    the date inversion is not read later as a bug. */}
                {prepayFor && (
                  <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <button onClick={() => prepayFor.retry()} disabled={attachBusy}
                      title="Records the pairing as a prepayment. Use it when the money really did go out first — a retainer, a deposit, an advance."
                      style={{ background: '#b45309', border: 'none', borderRadius: 6, color: '#fff',
                        fontSize: 11.5, fontWeight: 800, fontFamily: 'inherit', padding: '4px 10px',
                        cursor: attachBusy ? 'default' : 'pointer', opacity: attachBusy ? 0.5 : 1 }}>
                      It was a retainer or advance — attach anyway
                    </button>
                    <span style={{ fontSize: 11, color: C.textFaint }}>
                      {prepayFor.detail.days_early != null
                        ? `${prepayFor.detail.days_early} days early · paid ${prepayFor.detail.txn_date}, invoiced ${prepayFor.detail.invoice_date}`
                        : 'recorded as a prepayment'}
                      {' · '}otherwise check the invoice date, or pick the debit that actually settled it
                    </span>
                  </div>
                )}
              </div>
            )}
            <div style={{ maxHeight: folded.bankActivity ? 0 : 460, overflowY: 'auto',
              transition: 'max-height .15s' }}>
              {bankRowsOnly.map((t) => {
                const canAttach = t.status === 'open' || t.status === 'booked'
                const open = attachFor === t.id
                // The bank line in USD, so a foreign line is compared against an
                // invoice on the same basis rather than at face value.
                const lineUsd = Number(t.usd ?? t.amount)
                // A LINE THAT NEEDS NOTHING SHOULD RECEDE.
                //
                // "No invoice expected" is an answer — payroll, a card autopay, a
                // partner draw. Those rows read identically to the ones still
                // waiting, so a vendor whose list is half answered looks like a
                // vendor with twice the work. The only difference was one word
                // inside a sentence and a button reading "expect one".
                //
                // Receded, not hidden: the count above includes them and they stay
                // selectable, so the eye can skip them while the page still adds
                // up. Same treatment dismissed rows get in the review decks.
                const answered = t.no_invoice_expected || t.status === 'dismissed'
                // GROUND AND AN EDGE, not opacity. Opacity on the row would dim
                // the "expect one" button that undoes this very state, and a
                // parent's opacity cannot be undone by a child — so the way back
                // would be the faintest thing on the row. The ground says
                // "set aside" while every control stays crisp.
                const rowBg = answered ? (C.isDark ? '#181b23' : '#f6f7f9') : 'transparent'
                return (
                  <div key={t.id} style={{
                    borderBottom: '1px solid ' + C.tdBorder,
                    background: rowBg,
                    borderLeft: '3px solid ' + (answered ? (C.isDark ? '#3a4150' : '#d8dce3') : 'transparent'),
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 13px', fontSize: 13 }}>
                      {/* Only rows that CAN be answered get a box — a matched row
                          has its invoice, and a checkbox that leads to a refusal
                          is worse than no checkbox. */}
                      {/* Matched rows are selectable too. Withholding the box
                          meant a wrong match could be seen and not answered —
                          the only bulk actions were for rows with no invoice. */}
                      {(canAttach || t.status === 'matched') ? (
                        <input type="checkbox" checked={lineSel.has(t.id)} disabled={attachBusy}
                          onChange={() => setLineSel((prev) => {
                            const n = new Set(prev)
                            if (n.has(t.id)) n.delete(t.id); else n.add(t.id)
                            return n
                          })}
                          style={{ cursor: attachBusy ? 'default' : 'pointer', flexShrink: 0 }} />
                      ) : <span style={{ width: 13, flexShrink: 0 }} />}
                      {/* The statement lives on the date, where it belongs — it
                          was printed on every row, the same filename twelve times
                          down a page, competing with the invoice number and the
                          artist for the one flexible column. */}
                      <span title={t.filename ? `From ${t.filename}` : undefined}
                        style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, color: C.textFaint, width: 78, flexShrink: 0, cursor: t.filename ? 'help' : undefined }}>
                        {t.txn_date}
                      </span>
                      <span style={{ fontWeight: 700, color: C.text, width: 92, textAlign: 'right', flexShrink: 0 }}>
                        {fmt(t.amount, t.currency)}
                      </span>
                      <span style={{
                        fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em',
                        padding: '2px 7px', borderRadius: 4, flexShrink: 0,
                        background: t.status === 'open' ? '#fff1f2' : t.status === 'dismissed' ? (C.isDark ? '#262a35' : '#f3f4f6') : '#ecfdf5',
                        color: t.status === 'open' ? '#be123c' : t.status === 'dismissed' ? '#9ca3af' : '#047857',
                      }}>{t.status}</span>
                      {/* The ANSWER, as its own state beside the status rather
                          than a phrase buried in the description line where it
                          was competing with the invoice number, the artist and
                          the filename. Neutral by design: this is a settled row,
                          not a warning. */}
                      {t.no_invoice_expected && (
                        <span title="Answered: no invoice will ever exist for this line. Reversible — the button on the right puts it back in the queue."
                          style={{
                            fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em',
                            padding: '2px 7px', borderRadius: 4, flexShrink: 0,
                            background: C.isDark ? '#22262f' : '#eef0f3',
                            color: C.isDark ? '#9aa3b2' : '#6b7280',
                            border: '1px solid ' + (C.isDark ? '#2f3542' : '#e2e5ea'),
                          }}>no invoice needed</span>
                      )}
                      <span style={{ fontSize: 11, color: C.textFaint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                        {t.invoice_number ? `inv ${t.invoice_number} · ` : ''}
                        {/* The invoice's OWN total, and whether it agrees with
                            the payment. "inv 1828" alone cannot answer the
                            question this page is for; a $2,500 invoice against a
                            $5,000 debit is a part payment, which is a different
                            fact from a settled one. */}
                        {t.matched_expense_id && t.matched_amount != null && (() => {
                          const invAmt = Number(t.matched_amount)
                          const delta = Math.round((invAmt - Number(t.amount)) * 100) / 100
                          const sameCur = (t.matched_currency || 'USD') === (t.currency || 'USD')
                          return (
                            <span>
                              <span style={{ color: C.textMuted, fontWeight: 700 }}>{fmt(invAmt, t.matched_currency)}</span>
                              {sameCur && Math.abs(delta) > 0.005 && (
                                <span style={{ color: '#b45309', fontWeight: 600 }}
                                  title={`The invoice is ${delta > 0 ? 'larger' : 'smaller'} than this payment by ${fmt(Math.abs(delta), t.matched_currency)} — a part payment, or the wrong invoice.`}>
                                  {' '}({delta > 0 ? '+' : ''}{fmt(delta, t.matched_currency)})
                                </span>
                              )}
                              {!sameCur && <span style={{ color: C.textFaint }}> ({t.matched_currency} vs {t.currency || 'USD'})</span>}
                              {' · '}
                            </span>
                          )
                        })()}
                        {t.song || ''}
                      </span>
                      {/* WHO the spend was for, stated either way.
                          The artist was printed only when there WAS one, so an
                          unattributed payment looked identical to one nobody had
                          got to — and this list is where the 25-need-an-artist
                          band sends you. Spend by Artist covers a fraction of
                          real spending precisely because of these rows, so the
                          absence has to be visible, not inferred from a gap. */}
                      {/* An OPEN row has no entry, so these two controls MAKE
                          one rather than write to one. The artist is remembered
                          and the CATEGORY commits — the same order Bank Matching
                          uses, for the same reason: asked after the booking,
                          nobody answers, and that is how thousands of booked
                          rows ended up naming nobody. */}
                      {t.status === 'open' && canEditEntries && (
                        <>
                          {rowArtistFor === t.id ? (
                            <span onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0, minWidth: 150 }}>
                              <ArtistSelect value={openArtist[t.id] || ''} options={roster} autoFocus
                                disabled={editBusy} placeholder="Artist…"
                                onChange={(v) => { setOpenArtist((p) => ({ ...p, [t.id]: v })); setRowArtistFor(null) }}
                                className="text-[11.5px]"
                                style={{ border: '1px solid ' + C.border, borderRadius: 6, padding: '2px 6px',
                                  background: C.cardBg, color: C.text, fontFamily: 'inherit', width: '100%' }} />
                            </span>
                          ) : (
                            <button onClick={() => setRowArtistFor(t.id)} disabled={editBusy}
                              title={openArtist[t.id]
                                ? `Will be booked to ${openArtist[t.id]} — nothing is written until you pick a category.`
                                : 'Who this spend was for. Optional, and held until you pick a category — left blank, the vendor’s standing answer applies.'}
                              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', flexShrink: 0,
                                fontSize: 11, fontWeight: 700, fontFamily: 'inherit',
                                color: openArtist[t.id] ? '#7c3aed' : C.textFaint,
                                borderBottom: '1px dashed ' + (openArtist[t.id] ? '#c4b5fd' : C.border) }}>
                              {openArtist[t.id] || 'set artist'}
                            </button>
                          )}
                          {rowCatFor === t.id ? (
                            <span onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0, minWidth: 150 }}>
                              <CategorySelect value="" kind="expense" autoFocus disabled={editBusy}
                                onChange={(v) => { setRowCatFor(null); bookOpenRow(t, v) }}
                                className="text-[11.5px]"
                                style={{ border: '1px solid ' + C.border, borderRadius: 6, padding: '2px 6px',
                                  background: C.cardBg, color: C.text, fontFamily: 'inherit', width: '100%' }} />
                            </span>
                          ) : (
                            <button onClick={() => setRowCatFor(t.id)} disabled={editBusy}
                              title="Picking a category books this payment into the ledger, with the artist above if you set one. Nothing is written until then — and if an already-paid invoice matches, this refuses and names it so you can attach that instead."
                              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', flexShrink: 0,
                                fontSize: 11, fontWeight: 700, fontFamily: 'inherit', color: '#047857',
                                borderBottom: '1px dashed #6ee7b7' }}>
                              book as…
                            </button>
                          )}
                        </>
                      )}
                      {t.matched_expense_id && canEditEntries && (
                        rowArtistFor === t.id ? (
                          <span onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0, minWidth: 150 }}>
                            <ArtistSelect value={t.artist || ''} options={roster} autoFocus
                              disabled={editBusy} placeholder="Artist…"
                              onChange={(v) => saveRowArtist(t, v)}
                              className="text-[11.5px]"
                              style={{ border: '1px solid ' + C.border, borderRadius: 6, padding: '2px 6px',
                                background: C.cardBg, color: C.text, fontFamily: 'inherit', width: '100%' }} />
                          </span>
                        ) : (
                          <button onClick={() => setRowArtistFor(t.id)} disabled={editBusy}
                            title={t.artist
                              ? `Attributed to ${t.artist} — click to change. Writes to the ledger entry behind this payment.`
                              : 'Nobody is credited with this spend, so it is missing from Spend by Artist. Click to attribute it.'}
                            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', flexShrink: 0,
                              fontSize: 11, fontWeight: 700, fontFamily: 'inherit',
                              color: t.artist ? C.textMuted : '#b45309',
                              borderBottom: '1px dashed ' + (t.artist ? C.border : '#fcd34d') }}>
                            {t.artist || 'no artist'}
                          </button>
                        )
                      )}
                      {/* The category, editable in place. It was plain text
                          ("booked as Marketing"), so the one list that shows
                          every one of a vendor's payments was the one place you
                          could not categorise them — you had to find the entry in
                          the table above, or leave for Bank Matching.
                          Offered wherever there is an entry to write to, booked
                          or matched: a real invoice's category is just as often
                          the wrong one. */}
                      {t.matched_expense_id && canEditEntries && (
                        rowCatFor === t.id ? (
                          <span onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0, minWidth: 150 }}>
                            <CategorySelect value={t.matched_category || ''} kind="expense" autoFocus
                              disabled={editBusy}
                              onChange={(v) => saveRowCategory(t, v)}
                              className="text-[11.5px]"
                              style={{ border: '1px solid ' + C.border, borderRadius: 6, padding: '2px 6px',
                                background: C.cardBg, color: C.text, fontFamily: 'inherit', width: '100%' }} />
                          </span>
                        ) : (
                          <button onClick={() => setRowCatFor(t.id)} disabled={editBusy}
                            title={`Booked as ${t.matched_category || 'nothing yet'} — click to recategorize. Writes to the ledger entry behind this payment.`}
                            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', flexShrink: 0,
                              color: t.matched_category ? C.textMuted : C.textFaint, fontSize: 11,
                              fontWeight: 700, fontFamily: 'inherit',
                              borderBottom: '1px dashed ' + C.border }}>
                            {t.matched_category || 'set category'}
                          </button>
                        )
                      )}
                      {/* ONE control in ONE place, whichever state the row is in.
                          The moved state was a violet chip PLUS an undo, sitting
                          where the "move" link sits on every other row — and on a
                          vendor whose lines were nearly all moved it was a column
                          of identical badges saying what was true of everything.
                          A state that is the norm is not information.
                          It still has to be disclosable: the bank text names
                          another company, so the row would read as a bug. That
                          goes on the control's tooltip, where the reader is
                          already asking the question. */}
                      {/* Why a "PAYPAL" line is on this vendor's page at all: it
                          FUNDED one of the payments above. Without this the row
                          reads as somebody else's, because its own descriptor
                          names a payment channel and not a person. */}
                      {t.via_funding_pair && !t.vendor_override && (
                        <span title={`This bank pull funded the PayPal payment #${t.via_funding_pair} above — one payment, both statements. It is here because of that pair, not because the bank text names this vendor.`}
                          style={{ fontSize: 10, fontWeight: 700, color: C.textFaint, flexShrink: 0,
                            borderBottom: '1px dotted ' + C.border }}>
                          funded a PayPal payment
                        </span>
                      )}
                      {moveFor === `row:${t.id}`
                        ? movePicker((target, o) => moveBankRowTo(t, target, o))
                        : t.vendor_override ? (
                          <button onClick={() => clearBankRowVendor(t)} disabled={attachBusy}
                            title={`Filed here by hand — the bank calls this "${t.payee_guess}". Click to put it back with its descriptor's vendor.`}
                            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                              color: C.textFaint, fontSize: 10, fontWeight: 700, fontFamily: 'inherit', flexShrink: 0,
                              borderBottom: '1px dotted ' + C.border }}>
                            moved · undo
                          </button>
                        ) : (
                          <button onClick={() => { setMoveFor(`row:${t.id}`); setMoveQ(''); setMoveOpts([]) }}
                            disabled={attachBusy}
                            title="This payment belongs to a different vendor? Move just this line."
                            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                              color: C.textFaint, fontSize: 10, fontWeight: 700, fontFamily: 'inherit', flexShrink: 0 }}>
                            move
                          </button>
                        )}
                      {/* Read the document without leaving the page — the same
                          question ("is this the right invoice") and the same
                          pickDoc/fileUrl every other surface uses. */}
                      {t.matched_expense_id && (t.has_invoice || t.has_proof) && (() => {
                        const doc = pickDoc({ has_invoice: t.has_invoice, has_proof: t.has_proof,
                          invoice_filename: t.invoice_filename, proof_filename: t.proof_filename })
                        if (!doc) return null
                        return (
                          <button onClick={() => setPreviewFile({
                            url: fileUrl({ id: t.matched_expense_id }, doc.type),
                            filename: t.invoice_filename || t.proof_filename || doc.label,
                          })}
                            title={`Open the ${doc.label} this line is matched to`}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.textFaint,
                              padding: 0, display: 'inline-flex', flexShrink: 0 }}>
                            <FileText style={{ width: 13, height: 13 }} />
                          </button>
                        )
                      })()}
                      {canAttach && (
                        <button
                          // Opening a different line clears the selection: ticks
                          // belong to the payment they were made against, and
                          // carrying them over would offer to attach invoices
                          // somebody chose for a different row.
                          onClick={() => { setAttachErr(''); setAttachFor(open ? null : t.id) }} disabled={attachBusy}
                          title={t.status === 'booked'
                            ? 'This line was booked as its own ledger entry. Attaching a real invoice deletes that entry and links the invoice instead.'
                            : 'Link this bank line to one of this vendor’s invoices'}
                          style={{ background: 'none', border: '1px solid ' + C.border, borderRadius: 6, cursor: attachBusy ? 'default' : 'pointer',
                            color: C.textMuted, fontSize: 11, fontWeight: 700, fontFamily: 'inherit', padding: '3px 8px', flexShrink: 0, opacity: attachBusy ? 0.5 : 1 }}>
                          {open ? 'cancel' : 'attach invoice'} {open ? '' : '▾'}
                        </button>
                      )}
                      {/* ONE PRIMARY PER ROW. "attach invoice ▾" is what this
                          page is for and keeps its border; "no invoice" / "expect
                          one" / "split" were bordered pills of exactly the same
                          weight, so every row offered three equally-loud choices
                          and fourteen rows made a wall of them. They are text
                          actions now, the same weight as "move" and "unattach",
                          which is what they are: secondary answers.
                          Nothing is hidden and nothing moved — only the emphasis
                          changed, so muscle memory still lands. */}
                      {/* On the ROW, not buried in the picker. It was inside
                          "attach invoice ▾", which is why only 19 lines have ever
                          been marked — you had to open a list of invoices to say
                          there isn't one. */}
                      {canAttach && t.no_invoice_expected && (
                        <button onClick={() => expectInvoice(t)} disabled={attachBusy}
                          title="Put this line back in the queue — it will be asked for an invoice again."
                          style={{ background: 'none', border: 'none', padding: 0, cursor: attachBusy ? 'default' : 'pointer',
                            color: C.textFaint, fontSize: 10, fontWeight: 700, fontFamily: 'inherit', flexShrink: 0,
                            opacity: attachBusy ? 0.5 : 1 }}>
                          expect one
                        </button>
                      )}
                      {flagButton('bank', t)}
                      {canAttach && !t.no_invoice_expected && (
                        <button onClick={() => markNoInvoice(t)} disabled={attachBusy}
                          title="This payment never had an invoice — payroll, a card autopay, rent. Stops it being asked about."
                          style={{ background: 'none', border: 'none', padding: 0, cursor: attachBusy ? 'default' : 'pointer',
                            color: C.textFaint, fontSize: 10, fontWeight: 700, fontFamily: 'inherit', flexShrink: 0,
                            opacity: attachBusy ? 0.5 : 1 }}>
                          no invoice
                        </button>
                      )}
                      {/* One payment, two artists. Offered on booked and open
                          debits — a row matched to a real INVOICE is refused by
                          the server, because that document says what the payment
                          was for and a split would replace evidence with a
                          guess. */}
                      {canAttach && t.direction === 'debit' && (t.status === 'open' || t.match_method === 'created') && (
                        <button
                          onClick={() => {
                            if (splitFor === t.id) { setSplitFor(null); return }
                            setAttachErr('')
                            setSplitFor(t.id)
                            // Opens as two halves of the payment, which is the
                            // commonest split and saves typing the arithmetic.
                            const half = (Number(t.amount) / 2)
                            setSplitParts([
                              { amount: half.toFixed(2), category: t.category || 'Marketing', artist: '' },
                              { amount: (Number(t.amount) - Number(half.toFixed(2))).toFixed(2), category: 'Other', artist: '' },
                            ])
                          }}
                          disabled={attachBusy}
                          title="Book this one payment as several entries — a part per artist or category. Replaces the single entry we invented for it."
                          style={{ background: 'none', border: 'none', padding: 0, cursor: attachBusy ? 'default' : 'pointer',
                            color: splitFor === t.id ? C.text : C.textFaint, fontSize: 10, fontWeight: 700,
                            fontFamily: 'inherit', flexShrink: 0, opacity: attachBusy ? 0.5 : 1,
                            borderBottom: splitFor === t.id ? '1px solid ' + C.textMuted : 'none' }}>
                          split
                        </button>
                      )}
                      {(t.status === 'matched') && (
                        <button onClick={() => unattachLine(t)} disabled={attachBusy}
                          title={t.match_method === 'rematch'
                            ? 'Undo the swap — the invoice is unlinked and the booking this line had before it comes back.'
                            : 'Unlink this invoice from this bank line'}
                          style={{ background: 'none', border: 'none', cursor: attachBusy ? 'default' : 'pointer', color: C.textFaint,
                            fontSize: 11, fontWeight: 700, fontFamily: 'inherit', flexShrink: 0, opacity: attachBusy ? 0.5 : 1 }}>
                          unattach
                        </button>
                      )}
                    </div>

                    {splitFor === t.id && (() => {
                      const sum = splitParts.reduce((s, p) => s + (Number(p.amount) || 0), 0)
                      const remaining = Math.round((Number(t.amount) - sum) * 100) / 100
                      const setPart = (i, patch) => setSplitParts(splitParts.map((x, j) => (j === i ? { ...x, ...patch } : x)))
                      return (
                        <div style={{ padding: '8px 16px 12px 90px', background: C.isDark ? '#1a1d26' : '#fafafa' }}>
                          <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em',
                            color: C.textFaint, marginBottom: 6 }}>
                            Split {fmt(Number(t.amount), t.currency)} across artists or categories
                          </div>
                          {splitParts.map((p, i) => (
                            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                              <input type="number" step="0.01" min="0" value={p.amount}
                                onChange={(e) => setPart(i, { amount: e.target.value })}
                                style={{ width: 96, border: '1px solid ' + C.border, borderRadius: 6, padding: '5px 8px',
                                  fontSize: 12.5, fontFamily: 'ui-monospace, monospace', background: C.cardBg, color: C.text }} />
                              {/* Same picker as the table above. A split is
                                  where you pick several different categories in
                                  a row, so it is the worst place to be scrolling
                                  an OS menu. */}
                              <CategorySelect value={p.category} kind="expense"
                                onChange={(v) => setPart(i, { category: v })}
                                className="text-[12.5px]"
                                style={{ flex: 1, maxWidth: 200, border: '1px solid ' + C.border, borderRadius: 6,
                                  padding: '5px 8px', fontFamily: 'inherit', background: C.cardBg, color: C.text }} />
                              {/* WHO the spend was for — the usual reason to
                                  split a payment at all. Reports reads these,
                                  so each part lands on its own artist. */}
                              <ArtistSelect
                                value={p.artist || ''}
                                options={roster}
                                placeholder="Artist…"
                                onChange={(v) => setPart(i, { artist: v })}
                                className="w-32 border rounded-lg px-2 py-1 text-[12.5px] outline-none"
                              />
                              {splitParts.length > 2 && (
                                <button onClick={() => setSplitParts(splitParts.filter((_, j) => j !== i))}
                                  title="Remove this part"
                                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.textFaint, padding: 2 }}>
                                  <X size={13} />
                                </button>
                              )}
                            </div>
                          ))}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
                            {splitParts.length < 6 && (
                              <button onClick={() => setSplitParts([...splitParts,
                                { amount: Math.max(0, remaining).toFixed(2), category: 'Other', artist: '' }])}
                                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: C.textFaint,
                                  fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit' }}>
                                + add part
                              </button>
                            )}
                            <span style={{ fontSize: 11.5, fontWeight: 700, fontFamily: 'ui-monospace, monospace',
                              color: Math.abs(remaining) < 0.01 ? '#047857' : '#b45309' }}>
                              {Math.abs(remaining) < 0.01 ? 'balanced ✓'
                                : `${remaining > 0 ? 'remaining' : 'over by'} ${fmt(Math.abs(remaining), t.currency)}`}
                            </span>
                            <button onClick={() => bookSplit(t)} disabled={attachBusy || Math.abs(remaining) >= 0.01}
                              style={{ marginLeft: 'auto', background: '#059669', border: 'none', borderRadius: 6, color: '#fff',
                                fontSize: 11.5, fontWeight: 800, fontFamily: 'inherit', padding: '5px 12px',
                                cursor: (attachBusy || Math.abs(remaining) >= 0.01) ? 'default' : 'pointer',
                                opacity: (attachBusy || Math.abs(remaining) >= 0.01) ? 0.5 : 1 }}>
                              {attachBusy ? 'booking…' : 'Book split'}
                            </button>
                            <button onClick={() => { setSplitFor(null); setSplitParts([]) }}
                              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: C.textFaint,
                                fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit' }}>
                              cancel
                            </button>
                          </div>
                          {t.status !== 'open' && (
                            <div style={{ fontSize: 11, color: C.textFaint, marginTop: 6 }}>
                              This replaces the single entry we invented for this line — the payment is still counted once.
                            </div>
                          )}
                        </div>
                      )
                    })()}

                    {open && (
                      <div style={{ padding: '4px 16px 12px 90px', background: C.isDark ? '#1a1d26' : '#fafafa' }}>
                        {/* SEVERAL PAYMENTS, ONE INVOICE — offered here, where the
                            question actually arises.
                            This picker can only pair the line it belongs to, so on
                            a $500 payment against a $2,500 invoice every candidate
                            reads "+$2,000" and the way forward is a control in the
                            selection bar above, out of sight. That is the exact
                            spot John got stuck: two rows ticked, the right invoice
                            on screen, and the only visible action the wrong one.
                            The combined total is computed so the note can say
                            whether the selection actually covers something. */}
                        {(() => {
                          const others = bankRowsOnly.filter((x) => lineSel.has(x.id) && x.id !== t.id)
                          if (!others.length) return null
                          const together = [t, ...others].reduce((n, x) => n + Number(x.usd ?? x.amount ?? 0), 0)
                          return (
                            <div style={{ marginBottom: 8, padding: '7px 10px', borderRadius: 6,
                              background: C.isDark ? '#14261f' : '#ecfdf5',
                              border: '1px solid ' + (C.isDark ? '#1f4d3a' : '#a7f3d0'),
                              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                              <span style={{ fontSize: 11.5, color: C.text }}>
                                {others.length + 1} payments selected · <b>{fmt(together)}</b> together.
                                {' '}If one invoice covers all of them, attach them as a set — pairing this line alone
                                {' '}leaves the rest of that invoice unsettled.
                              </span>
                              <button onClick={() => { setAttachErr(''); setAttachFor(null); setMultiFor([t.id, ...others.map((x) => x.id)]) }}
                                disabled={attachBusy}
                                style={{ background: '#059669', border: 'none', borderRadius: 6, color: '#fff',
                                  fontSize: 11, fontWeight: 800, fontFamily: 'inherit', padding: '4px 10px',
                                  cursor: attachBusy ? 'default' : 'pointer', opacity: attachBusy ? 0.5 : 1 }}>
                                Attach all {others.length + 1} to one invoice
                              </button>
                            </div>
                          )
                        })()}
                        {/* The SHARED picker — the same component Bank Matching
                            uses, so "attach" means one thing in both places. It
                            owns ticking several, the running total against the
                            line, the USD delta and reading the document first. */}
                        <InvoiceAttachPicker
                          candidates={attachable}
                          lineUsd={lineUsd}
                          lineDate={t.txn_date}
                          busy={attachBusy}
                          dark={C}
                          onPreview={setPreviewFile}
                          onAttach={(ids) => attachInvoices(t, ids)}
                          emptyText="Every invoice this vendor has already has a bank line behind it. Either this payment's invoice hasn't been entered yet, or this line never had one."
                        />
                        {/* The honest answer for most booked lines. SPOTIFY,
                            payroll, card autopay: no invoice is coming, and
                            saying so is what lets the count reach zero. */}
                        {!t.no_invoice_expected && (
                          <button onClick={() => markNoInvoice(t)} disabled={attachBusy}
                            style={{ marginTop: 6, background: 'none', border: 'none', padding: 0, cursor: attachBusy ? 'default' : 'pointer',
                              color: C.textFaint, fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit', textDecoration: 'underline', opacity: attachBusy ? 0.5 : 1 }}>
                            No invoice will ever exist for this line
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
              {/* PAYPAL.
                  A different statement with a different meaning: every PayPal
                  payment is ALSO on the bank statement as a nameless
                  "PAYPAL DES:…" pull filed under the PAYPAL payee, so the two
                  halves could never be seen together on the page that names the
                  recipient. Each row states which bank line funded it and
                  whether that line has been closed — which is what makes the
                  money provably counted once. */}
              {ppRows.length > 0 && (
                <div style={{ borderTop: '1px solid ' + C.border, background: C.isDark ? '#1b2030' : '#f8fafc' }}>
                  <div style={{ padding: '10px 16px 4px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <button
                      onClick={() => toggleFold('ppActivity')}
                      title={folded.ppActivity ? 'Show the PayPal lines' : 'Fold the PayPal lines away'}
                      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit',
                        display: 'flex', alignItems: 'center', gap: 5 }}
                    >
                      <ChevronRight style={{ width: 11, height: 11, color: '#0369a1',
                        transform: folded.ppActivity ? 'none' : 'rotate(90deg)', transition: 'transform .12s' }} />
                      <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#0369a1' }}>
                        PayPal activity ({ppRows.length})
                      </span>
                    </button>
                    <span style={{ fontSize: 11.5, color: C.textFaint }}>
                      {fmt(ppRows.reduce((sum, t) => sum + Math.abs(Number(t.usd) || 0), 0))}
                      {' · '}funded from the bank account, so each of these also appears on a bank statement — the copy
                      the P&L and Financials count, which is what these close against
                    </span>
                    {ppRows.some((t) => t.double_funded) && (
                      <span style={{ fontSize: 11, fontWeight: 800, color: '#b91c1c', background: C.isDark ? '#3b1f24' : '#fff1f2',
                        border: '1px solid ' + (C.isDark ? '#7f2d36' : '#fecdd3'), padding: '2px 8px', borderRadius: 4 }}
                        title="Both halves of the same payment carry a ledger entry, so one payment is counted twice. Pairing them closes the bank pull and keeps the record on the PayPal row, which is the one that names the recipient.">
                        {ppRows.filter((t) => t.double_funded).length} counted twice
                      </span>
                    )}
                  </div>
                  {!folded.ppActivity && ppRows.map((t) => (
                    <div key={t.id} style={{ padding: '7px 16px', borderTop: '1px solid ' + C.tdBorder,
                      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12.5 }}>
                      <span style={{ color: C.textFaint, minWidth: 74 }}>{fmtDate(t.txn_date)}</span>
                      <span style={{ fontFamily: 'ui-monospace, monospace', fontWeight: 700, color: C.text, minWidth: 90, textAlign: 'right' }}>
                        {fmt(t.amount, t.currency)}
                      </span>
                      <span style={{ color: C.textMuted, flex: 1, minWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={t.payee_guess || ''}>
                        {t.payee_guess || '—'}
                      </span>
                      {/* Same three states this page uses everywhere else. */}
                      <span style={{ fontSize: 11, fontWeight: 700,
                        color: t.status === 'matched' ? '#047857' : t.status === 'dismissed' ? C.textFaint : '#b45309' }}>
                        {t.status === 'matched' ? '✓ invoice'
                          : t.status === 'booked' ? 'booked, no invoice'
                          : t.status === 'dismissed' ? 'dismissed' : 'open'}
                      </span>
                      {/* WHO the spend was for — the same control the bank rows
                          got, because these rows are counted by the same artist
                          band above and were the ONLY place it pointed.
                          John's report: "i dont see any booked payments with no
                          artist under bank activity for this vendor." All three
                          were here, on the PayPal statement, in a section that
                          had no way to answer. The band counted 24 rows; the bank
                          list it sits above renders 17. */}
                      {/* An OPEN row has no entry, so these two controls MAKE
                          one rather than write to one. The artist is remembered
                          and the CATEGORY commits — the same order Bank Matching
                          uses, for the same reason: asked after the booking,
                          nobody answers, and that is how thousands of booked
                          rows ended up naming nobody. */}
                      {t.status === 'open' && canEditEntries && (
                        <>
                          {rowArtistFor === t.id ? (
                            <span onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0, minWidth: 150 }}>
                              <ArtistSelect value={openArtist[t.id] || ''} options={roster} autoFocus
                                disabled={editBusy} placeholder="Artist…"
                                onChange={(v) => { setOpenArtist((p) => ({ ...p, [t.id]: v })); setRowArtistFor(null) }}
                                className="text-[11.5px]"
                                style={{ border: '1px solid ' + C.border, borderRadius: 6, padding: '2px 6px',
                                  background: C.cardBg, color: C.text, fontFamily: 'inherit', width: '100%' }} />
                            </span>
                          ) : (
                            <button onClick={() => setRowArtistFor(t.id)} disabled={editBusy}
                              title={openArtist[t.id]
                                ? `Will be booked to ${openArtist[t.id]} — nothing is written until you pick a category.`
                                : 'Who this spend was for. Optional, and held until you pick a category — left blank, the vendor’s standing answer applies.'}
                              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', flexShrink: 0,
                                fontSize: 11, fontWeight: 700, fontFamily: 'inherit',
                                color: openArtist[t.id] ? '#7c3aed' : C.textFaint,
                                borderBottom: '1px dashed ' + (openArtist[t.id] ? '#c4b5fd' : C.border) }}>
                              {openArtist[t.id] || 'set artist'}
                            </button>
                          )}
                          {rowCatFor === t.id ? (
                            <span onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0, minWidth: 150 }}>
                              <CategorySelect value="" kind="expense" autoFocus disabled={editBusy}
                                onChange={(v) => { setRowCatFor(null); bookOpenRow(t, v) }}
                                className="text-[11.5px]"
                                style={{ border: '1px solid ' + C.border, borderRadius: 6, padding: '2px 6px',
                                  background: C.cardBg, color: C.text, fontFamily: 'inherit', width: '100%' }} />
                            </span>
                          ) : (
                            <button onClick={() => setRowCatFor(t.id)} disabled={editBusy}
                              title="Picking a category books this payment into the ledger, with the artist above if you set one. Nothing is written until then — and if an already-paid invoice matches, this refuses and names it so you can attach that instead."
                              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', flexShrink: 0,
                                fontSize: 11, fontWeight: 700, fontFamily: 'inherit', color: '#047857',
                                borderBottom: '1px dashed #6ee7b7' }}>
                              book as…
                            </button>
                          )}
                        </>
                      )}
                      {t.matched_expense_id && canEditEntries && (
                        rowArtistFor === t.id ? (
                          <span onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0, minWidth: 150 }}>
                            <ArtistSelect value={t.artist || ''} options={roster} autoFocus
                              disabled={editBusy} placeholder="Artist…"
                              onChange={(v) => saveRowArtist(t, v)}
                              className="text-[11.5px]"
                              style={{ border: '1px solid ' + C.border, borderRadius: 6, padding: '2px 6px',
                                background: C.cardBg, color: C.text, fontFamily: 'inherit', width: '100%' }} />
                          </span>
                        ) : (
                          <button onClick={() => setRowArtistFor(t.id)} disabled={editBusy}
                            title={t.artist
                              ? `Attributed to ${t.artist} — click to change.`
                              : 'Nobody is credited with this spend, so it is missing from Spend by Artist. Click to attribute it.'}
                            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', flexShrink: 0,
                              fontSize: 11, fontWeight: 700, fontFamily: 'inherit',
                              color: t.artist ? C.textMuted : '#b45309',
                              borderBottom: '1px dashed ' + (t.artist ? C.border : '#fcd34d') }}>
                            {t.artist || 'no artist'}
                          </button>
                        )
                      )}
                      {/* The bank half. "closed" is the correct resting state:
                          the pull is dismissed as a funding leg so the payment
                          is counted once, from here. */}
                      <span style={{ fontSize: 11, color: t.funding_proposal ? '#b45309' : C.textFaint, minWidth: 200 }}>
                        {t.funding ? (
                          t.status === 'dismissed'
                            ? `counted on the bank statement · #${t.funding.id} · ${fmtDate(t.funding.txn_date)}`
                            : `bank #${t.funding.id} · ${fmtDate(t.funding.txn_date)} · both still counting`
                        ) : t.funding_proposal ? (
                          /* The evidence, stated, because this one is a proposal
                             rather than an equality: a GBP payment funded by a
                             USD pull can only ever be matched on a name, a date
                             and PayPal's spread. Showing the spread is what lets
                             someone disagree with it. */
                          `likely funded by bank #${t.funding_proposal.id} · ${fmtDate(t.funding_proposal.txn_date)}`
                          + ` · ${t.funding_proposal.days}d · ${t.funding_proposal.currency} ${t.funding_proposal.bank_usd}`
                          + ` vs $${t.funding_proposal.paypal_usd} (+${t.funding_proposal.spread_pct}% spread)`
                        ) : t.funding_contested ? (
                          `bank #${t.funding_contested.bank_id} · ${fmtDate(t.funding_contested.txn_date)} · `
                          + `${t.funding_contested.claimants.length} payments want it`
                        ) : 'no bank pull found within a week'}
                      </span>
                      {/* A pull two payments want equally. Nothing claims it — that
                          is the whole point of the allocation — but a person can
                          almost always read the descriptor even where no rule can
                          ("ID:DIEGOADRIANPERE" is diego perez), so the candidates
                          are offered rather than the question being buried.
                          Shown whatever the row's status: the closed PayPal copy is
                          usually the one carrying the pair, so hiding this on
                          dismissed rows would hide most of them. */}
                      {t.funding_contested && (
                        <span onClick={(e) => e.stopPropagation()}
                          style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                          <span title={`The bank text reads "${t.funding_contested.description || ''}" — it usually names the recipient even when no rule can read it. Nothing has been filed against this pull.`}
                            style={{ fontSize: 10, fontWeight: 700, color: '#b45309',
                              borderBottom: '1px dotted #fcd34d' }}>
                            whose?
                          </span>
                          {t.funding_contested.claimants.map((c) => (
                            <button key={c.txn_id} onClick={() => claimContestedPull(t, c)} disabled={attachBusy}
                              title={`File bank #${t.funding_contested.bank_id} with ${c.ledger_payee || c.payee}'s payment of ${fmtDate(c.txn_date)}. Written as a move, so it is undoable from that row.`}
                              style={{ background: 'none', border: '1px solid ' + C.border, borderRadius: 5,
                                padding: '1px 6px', cursor: 'pointer', fontSize: 10, fontWeight: 700,
                                fontFamily: 'inherit', color: c.mine ? '#047857' : C.textMuted }}>
                              {c.mine ? 'this payment' : (c.ledger_payee || c.payee || `#${c.txn_id}`)}
                            </button>
                          ))}
                        </span>
                      )}
                      {/* A cross-currency proposal closes through the SAME endpoint
                          as an exact pair — the difference is that a person had to
                          agree first, so the button says so. */}
                      {t.funding_proposal && t.status !== 'dismissed' && (
                        <button onClick={() => pairFunding(t, false, t.funding_proposal.id)} disabled={attachBusy}
                          title={t.funding_proposal_double
                            ? `Both halves carry a ledger entry, so this payment is counted twice. The bank pull is ${t.funding_proposal.currency} ${t.funding_proposal.bank_usd} against $${t.funding_proposal.paypal_usd} converted — a ${t.funding_proposal.spread_pct}% PayPal spread, ${t.funding_proposal.days} day(s) apart. Closing keeps the record on the bank statement row, which is what the P&L counts.`
                            : `Confirm this bank pull funded the payment and close the PayPal copy. Matched on the recipient's name, ${t.funding_proposal.days} day(s) apart, ${t.funding_proposal.spread_pct}% spread — not on an exact amount, because the currencies differ.`}
                          style={{ marginLeft: 'auto', background: 'none',
                            border: '1px solid ' + (t.funding_proposal_double ? '#b45309' : C.border), borderRadius: 6,
                            color: t.funding_proposal_double ? '#b45309' : C.textMuted, fontSize: 11, fontWeight: 700,
                            fontFamily: 'inherit', padding: '3px 9px', flexShrink: 0,
                            cursor: attachBusy ? 'default' : 'pointer', opacity: attachBusy ? 0.5 : 1 }}>
                          close against the statement?
                        </button>
                      )}
                      {t.funding && t.status !== 'dismissed' && (
                        <button onClick={() => pairFunding(t)} disabled={attachBusy}
                          title={t.double_funded
                            ? 'Both halves carry a ledger entry — this closes the PayPal copy and keeps the record on the bank statement row, which is what the P&L and Financials count.'
                            : 'Close this PayPal copy against its bank statement row, moving the record there, so the same money is counted once.'}
                          style={{ marginLeft: 'auto', background: t.double_funded ? '#b91c1c' : 'none',
                            border: '1px solid ' + (t.double_funded ? '#b91c1c' : C.border), borderRadius: 6,
                            color: t.double_funded ? '#fff' : C.textMuted, fontSize: 11, fontWeight: 700,
                            fontFamily: 'inherit', padding: '3px 9px', flexShrink: 0,
                            cursor: attachBusy ? 'default' : 'pointer', opacity: attachBusy ? 0.5 : 1 }}>
                          close against the statement
                        </button>
                      )}
                      {t.status === 'dismissed' && t.funding && (
                        <button onClick={() => pairFunding(t, true)} disabled={attachBusy}
                          title="Bring the PayPal copy back and, if the ledger entry moved to the bank row, send it back with it."
                          style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: attachBusy ? 'default' : 'pointer',
                            color: C.textFaint, fontSize: 11, fontWeight: 700, fontFamily: 'inherit', flexShrink: 0,
                            opacity: attachBusy ? 0.5 : 1 }}>
                          undo
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {/* MONEY THAT CAME BACK.
                  Reversals are excluded from the review deck — a refund is
                  neither an expense to invoice nor income — so without this
                  section they are invisible on the one page devoted to this
                  vendor, and the spend above reads higher than it was.
                  Both legs are shown, because a pair is only judgeable together. */}
              {(bankAct.reversals || []).length > 0 && (
                <div style={{ borderTop: '1px solid ' + C.border, background: C.isDark ? '#241f1a' : '#fffbeb' }}>
                  <div style={{ padding: '10px 16px 4px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#b45309' }}>
                      Reversals &amp; refunds ({bankAct.reversals.length})
                    </span>
                    <span style={{ fontSize: 11.5, color: C.textFaint }}>
                      {/* Both figures, because "how much came back" and "how much
                          is still counting somewhere" are different questions and
                          the second is the one that needs work. An unresolved pair
                          still sits in the totals above. */}
                      {fmt((bankAct.reversals || []).reduce((n, r) => n + Math.abs(Number(r.amount) || 0), 0))}
                      {' '}went out and came back — neither an expense nor income
                      {(() => {
                        const open = (bankAct.reversals || []).filter((r) => !r.resolved)
                        if (!open.length) return null
                        return (
                          <span style={{ color: '#b45309', fontWeight: 700 }}>
                            {' · '}{fmt(open.reduce((n, r) => n + Math.abs(Number(r.amount) || 0), 0))} still counting ({open.length})
                          </span>
                        )
                      })()}
                    </span>
                  </div>
                  {bankAct.reversals.map((r) => (
                    <div key={`${r.debit.id}-${r.credit.id}`}
                      style={{ padding: '6px 16px 10px', fontSize: 12.5, color: C.text }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 700, fontFamily: 'ui-monospace, monospace' }}>{fmt(r.amount)}</span>
                        <span style={{ color: C.textFaint }}>
                          out {r.debit.txn_date} → back {r.credit.txn_date}
                        </span>
                        {r.resolved ? (
                          <span style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em',
                            color: '#047857', background: '#ecfdf5', padding: '2px 6px', borderRadius: 4 }}
                            title="Both sides dismissed — the pair nets to zero and neither reaches the P&L.">
                            settled
                          </span>
                        ) : (
                          <span style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em',
                            color: '#b45309', background: C.isDark ? '#3a2f1a' : '#fef3c7', padding: '2px 6px', borderRadius: 4 }}
                            title="One or both legs still count somewhere. Dismiss both sides on Bank Matching so the expense stops counting and no revenue is invented.">
                            still counting
                          </span>
                        )}
                        {r.debit.matched_expense_id && (
                          <span style={{ fontSize: 11, color: '#b45309' }}>
                            the original is still {r.debit.match_method === 'created' ? 'booked' : 'matched'}
                          </span>
                        )}
                        {/* Resolved HERE. It used to send you to Bank Matching
                            to do the same three things — the vendor page is
                            where you can see this pair against everything else
                            the vendor did, which is the context that tells you
                            whether it really was a bounce. */}
                        {r.resolved ? (
                          <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: '#047857' }}>
                            resolved
                            {revUndo && revUndo.debit.id === r.debit.id && (
                              <button onClick={() => undoReversal(revUndo)} disabled={attachBusy}
                                style={{ background: 'none', border: 'none', padding: '0 0 0 8px', cursor: 'pointer',
                                  color: C.textFaint, fontSize: 11, fontWeight: 700, fontFamily: 'inherit' }}>
                                undo
                              </button>
                            )}
                          </span>
                        ) : (
                          <button onClick={() => resolveReversal(r)} disabled={attachBusy}
                            style={{ marginLeft: 'auto', background: '#b45309', border: 'none', borderRadius: 6,
                              padding: '3px 10px', cursor: attachBusy ? 'default' : 'pointer', color: '#fff',
                              fontSize: 11, fontWeight: 800, fontFamily: 'inherit', opacity: attachBusy ? 0.5 : 1 }}
                            title="Drops the record this debit carries and dismisses both legs, so money that came back stops counting as spend.">
                            resolve
                          </button>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: C.textFaint, marginTop: 2 }}>
                        {String(r.debit.description || '').slice(0, 60)} · {String(r.credit.description || '').slice(0, 60)}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* The pile, and the one action that can clear it. Offered only
                  when there IS a pile — a vendor with one waiting line does not
                  need a rule, it needs a decision about that line. */}
              {(() => {
                // The SERVER's count, over every line of this vendor — not the
                // loaded page. Derived from the page, FACEBOOK reported 0 waiting
                // and hid this footer, because its newest 100 lines are answered
                // and all 118 unanswered ones sit past the cap. The rule this
                // button writes covers them all regardless of what is on screen,
                // so the count must too.
                const waitingN = bankAct.waiting_n ?? (bankAct.transactions || []).filter(
                  (t) => (t.status === 'open' || t.status === 'booked') && !t.no_invoice_expected).length
                const loadedWaiting = (bankAct.transactions || []).filter(
                  (t) => (t.status === 'open' || t.status === 'booked') && !t.no_invoice_expected).length
                if (waitingN < 2) return null
                const unresolved = { length: waitingN }
                return (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                    padding: '10px 16px', borderTop: '1px solid ' + C.tdBorder,
                    background: C.isDark ? '#1a1d26' : '#fafafa' }}>
                    <span style={{ fontSize: 12, color: C.text, fontWeight: 600 }}>
                      {waitingN} payment{waitingN === 1 ? '' : 's'} here still waiting for an invoice
                      {bankAct.waiting_total != null && (
                        <span style={{ fontWeight: 500, color: C.textFaint }}> · {fmt(bankAct.waiting_total)}</span>
                      )}
                      {/* Says when the list on screen is not the whole set, so
                          "mark all N" is not read as "mark the ones I can see". */}
                      {loadedWaiting < waitingN && (
                        <span style={{ fontWeight: 500, color: C.textFaint }}>
                          {' · '}{loadedWaiting} of them listed above
                        </span>
                      )}
                    </span>
                    <button onClick={() => markVendorNoInvoice(unresolved.length)} disabled={attachBusy}
                      title="For a vendor that never invoices — a card, a subscription, payroll. Writes a rule covering this vendor's names; reversible from the Upload Rules page."
                      style={{ background: 'none', border: '1px solid ' + C.border, borderRadius: 6,
                        cursor: attachBusy ? 'default' : 'pointer', color: C.textMuted, fontSize: 11.5,
                        fontWeight: 700, fontFamily: 'inherit', padding: '4px 10px',
                        opacity: attachBusy ? 0.5 : 1 }}>
                      This vendor never sends invoices — mark all {unresolved.length}
                    </button>
                    <span style={{ fontSize: 11, color: C.textFaint }}>
                      writes a rule · nothing moves in the ledger · reversible
                    </span>
                  </div>
                )
              })()}

              {/* Say what isn't here. The list is capped, and a capped list under a
                  summary counting every line reads as "this is all of them". */}
              {bankAct.truncated && (
                <div style={{ padding: '8px 16px', fontSize: 11.5, color: C.textFaint }}>
                  Showing the {bankAct.shown} most recent of {bankAct.matched_txns} bank lines for this vendor —
                  {' '}
                  <button onClick={() => navigate(`/bk/bank-matching?q=${encodeURIComponent((bankAct.payees[0]?.name) || vendorDetail.payee || '')}`)}
                    style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: C.textMuted,
                      fontSize: 11.5, fontWeight: 700, fontFamily: 'inherit', textDecoration: 'underline' }}>
                    see them all on Bank Matching
                  </button>.
                </div>
              )}
            </div>
          </div>
        )}
        {previewFile && <FilePreview url={previewFile.url} filename={previewFile.filename} onClose={() => setPreviewFile(null)} />}
      </div>
    )
  }

  // ── List view ──
  return (
    <div data-tour="vendor-page" style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.pageBg, fontSize: 14 }}>

      {/* Toolbar */}
      <div style={{
        padding: '10px 16px', display: 'flex', gap: 8, alignItems: 'center',
        justifyContent: 'space-between', borderBottom: '1px solid ' + C.border,
        background: C.cardBg, flexWrap: 'wrap', position: 'sticky', top: 0, zIndex: 10,
      }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', flex: 1 }}>
          <div style={{ position: 'relative' }}>
            <Search style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', width: 15, height: 15, color: '#aaa' }} />
            <input
              type="text" placeholder="Search vendors…"
              value={search} onChange={e => setSearch(e.target.value)}
              style={inputSty}
            />
          </div>
          <select style={selectSty} value={w9Filter} onChange={e => setW9Filter(e.target.value)}>
            {W9_FILTER.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
          <select style={selectSty} value={sortBy} onChange={e => setSortBy(e.target.value)}>
            {SORT_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
          {/* Invoice-less added-expense payees get their own tracking
              subpage (totals + duplicate recommendations). */}
          <button
            onClick={() => navigate('/bk/vendors/added-expenses')}
            style={{ ...toolbarBtn, display: 'flex', alignItems: 'center', gap: 4 }}
            title="Creators paid via the add-expense modals — no invoices on file; totals and duplicate warnings tracked separately"
          >
            <Package style={{ width: 13, height: 13 }} /> Added expenses
          </button>
          {vendors.filter(v => v.w9_mismatch).length > 0 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#fef2f2', color: '#dc2626', padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
              <AlertTriangle style={{ width: 12, height: 12 }} />
              {vendors.filter(v => v.w9_mismatch).length} name mismatch{vendors.filter(v => v.w9_mismatch).length !== 1 ? 'es' : ''}
            </span>
          )}
          <button
            onClick={handleScanW9s}
            disabled={scanning}
            style={{ ...toolbarBtn, display: 'flex', alignItems: 'center', gap: 4, opacity: scanning ? 0.5 : 1 }}
          >
            <RefreshCw style={{ width: 13, height: 13, animation: scanning ? 'spin 0.8s linear infinite' : 'none' }} />
            {scanning ? 'Scanning...' : 'Scan W9s'}
          </button>
          {scanResult && (
            <span style={{ fontSize: 11, color: scanResult.error ? '#dc2626' : '#16a34a', fontWeight: 600 }}>
              {scanResult.error || `Scanned ${scanResult.scanned}${scanResult.remaining > 0 ? ` · ${scanResult.remaining} remaining` : ''}`}
            </span>
          )}
          {/* The same deck Vendor Flags opens, over the same pairs. One count,
              one component — a second implementation here is how two Review
              buttons ended up disagreeing on Bank Matching. */}
          {dupes.length > 0 && (
            <button
              onClick={() => setDeckOpen(true)}
              title="Review the likely duplicate vendors one card at a time. Every merge is undoable from inside the deck."
              style={{ ...toolbarBtn, display: 'flex', alignItems: 'center', gap: 4, background: C.text, color: C.cardBg, borderColor: C.text, fontWeight: 700 }}
            >
              <Zap style={{ width: 13, height: 13 }} />
              Review {dupes.length} duplicate{dupes.length === 1 ? '' : 's'}
            </button>
          )}
          <span style={{ color: '#9ca3af', fontSize: 12, whiteSpace: 'nowrap' }}>{filtered.length} vendors</span>
          <div style={{ display: 'flex', gap: 2, background: C.elevBg, borderRadius: 6, padding: 2 }}>
            <button onClick={() => setView('table')} style={{ padding: '4px 6px', borderRadius: 4, background: view === 'table' ? C.cardBg : 'transparent', border: 'none', cursor: 'pointer', display: 'flex' }} title="Table">
              <LayoutList style={{ width: 14, height: 14, color: view === 'table' ? C.text : '#999' }} />
            </button>
            <button onClick={() => setView('cards')} style={{ padding: '4px 6px', borderRadius: 4, background: view === 'cards' ? C.cardBg : 'transparent', border: 'none', cursor: 'pointer', display: 'flex' }} title="Cards">
              <LayoutGrid style={{ width: 14, height: 14, color: view === 'cards' ? C.text : '#999' }} />
            </button>
          </div>
          {(search || w9Filter !== 'All') && (
            <>
              <div style={{ width: 1, height: 20, background: C.border }} />
              <button
                style={toolbarBtn}
                onClick={() => { setSearch(''); setW9Filter('All'); setSortBy('Spent: high') }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = RED; e.currentTarget.style.color = RED }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.color = C.textMuted }}
              >
                Clear
              </button>
            </>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{ margin: '10px 16px 0', background: '#fef2f2', border: '1px solid #fca5a5', color: '#991b1b', padding: '10px 14px', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <AlertCircle style={{ width: 16, height: 16, flexShrink: 0 }} />
          {error}
          <button onClick={() => setError('')} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#991b1b', fontSize: 14, cursor: 'pointer' }}>✕</button>
        </div>
      )}

      {/* Content */}
      <div style={{ flex: 1, overflowX: 'auto', overflowY: 'auto' }}>
        {filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 20px', color: '#999', fontSize: 14 }}>
            {vendors.length === 0 ? 'No vendors found.' : 'No vendors match your filters.'}
          </div>
        ) : view === 'cards' ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, padding: 16 }}>
            {filtered.map(vendor => (
              <div
                key={vendor.payee}
                onClick={() => fetchVendorDetail(vendor.payee)}
                style={{ background: C.cardBg, borderRadius: 10, border: '1px solid ' + C.border, padding: '16px 18px', cursor: 'pointer', transition: 'all 0.15s' }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = '#ccc'; e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,.06)' }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.boxShadow = 'none' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input
                        type="checkbox"
                        checked={mergeSelection.has(vendor.payee)}
                        onChange={() => toggleMergeSelect(vendor.payee)}
                        onClick={e => e.stopPropagation()}
                        style={{ width: 15, height: 15, cursor: 'pointer', accentColor: RED, flexShrink: 0 }}
                        title="Select for merge"
                      />
                      <span style={{ fontWeight: 700, fontSize: 14, color: RED }}>{vendor.payee}</span>
                      {vendor.w9_mismatch && (
                        <span title={`W9 name: ${vendor.w9_name || 'unknown'}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, background: '#fef2f2', color: '#dc2626', padding: '1px 6px', borderRadius: 4, fontSize: 10, fontWeight: 700 }}>
                          <AlertTriangle style={{ width: 10, height: 10 }} />
                        </span>
                      )}
                    </div>
                    {vendor.vendor_email && <div style={{ fontSize: 12, color: '#999', marginTop: 2 }}>{vendor.vendor_email}</div>}
                  </div>
                  {(() => {
                    const busy = uploadingW9For === vendor.payee
                    const over = w9DragOverFor === vendor.payee
                    return (
                      <div
                        onClick={e => { e.stopPropagation(); if (!busy) document.getElementById(`w9-input-card-${vendor.payee}`)?.click() }}
                        onDragOver={e => { e.preventDefault(); e.stopPropagation(); setW9DragOverFor(vendor.payee) }}
                        onDragLeave={e => { e.stopPropagation(); setW9DragOverFor(null) }}
                        onDrop={e => {
                          e.preventDefault(); e.stopPropagation(); setW9DragOverFor(null)
                          const file = e.dataTransfer.files?.[0]
                          if (file) uploadW9(vendor.payee, file)
                        }}
                        title={vendor.w9_on_file ? 'Drop a new W9 to replace' : 'Drop a W9 file here'}
                        style={{
                          border: `1.5px dashed ${over ? '#6366f1' : (vendor.w9_on_file ? C.badgeYesBg : C.badgeNoBg)}`,
                          borderRadius: 6, padding: '2px 8px', cursor: busy ? 'default' : 'pointer',
                          background: over ? '#eef2ff' : 'transparent',
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
                          color: vendor.w9_on_file ? C.badgeYesText : C.badgeNoText,
                          opacity: busy ? 0.5 : 1,
                        }}
                      >
                        {busy
                          ? <Loader style={{ width: 11, height: 11, animation: 'spin 0.8s linear infinite' }} />
                          : <Upload style={{ width: 11, height: 11 }} />}
                        {vendor.w9_on_file ? 'W9' : 'No W9'}
                        <input
                          id={`w9-input-card-${vendor.payee}`}
                          type="file"
                          accept=".pdf,.png,.jpg,.jpeg"
                          style={{ display: 'none' }}
                          onChange={e => {
                            const file = e.target.files?.[0]
                            if (file) uploadW9(vendor.payee, file)
                            e.target.value = ''
                          }}
                        />
                      </div>
                    )
                  })()}
                </div>
                <div style={{ display: 'flex', gap: 16, fontSize: 12 }}>
                  <div>
                    <div style={{ color: '#9ca3af', fontWeight: 700, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Spent</div>
                    <div style={{ fontWeight: 900, fontSize: 16, color: C.text }}>{fmt(vendor.total_spent)}</div>
                  </div>
                  <div>
                    <div style={{ color: '#9ca3af', fontWeight: 700, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Invoices</div>
                    <div style={{ fontWeight: 700, color: '#555' }}>{vendor.invoice_count}</div>
                  </div>
                  <div>
                    <div style={{ color: '#9ca3af', fontWeight: 700, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Last</div>
                    <div style={{ color: '#777' }}>{fmtDate(vendor.last_invoice)}</div>
                  </div>
                </div>
                {parseFloat(vendor.total_spent_usd ?? vendor.total_spent ?? 0) >= 2000 && (
                  <div style={{ marginTop: 10, fontSize: 10, fontWeight: 700, color: '#92400e', background: '#fef9c3', padding: '2px 8px', borderRadius: 4, display: 'inline-block' }}>
                    Qualifies for 1099
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
          <table style={{ width: '100%', minWidth: 560, borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ ...TH, width: 34 }} title="Select vendors to merge"></th>
                <th style={TH}>Vendor</th>
                <th style={{ ...TH, textAlign: 'center' }}>Invoices</th>
                <th style={{ ...TH, textAlign: 'right' }}>Total Spent</th>
                <th style={TH}>Last Invoice</th>
                <th style={{ ...TH, textAlign: 'center' }}>W9</th>
                <th style={{ ...TH, textAlign: 'center' }}>1099</th>
                <th style={TH}>Email</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(vendor => (
                <tr
                  key={vendor.payee}
                  style={{ background: C.rowBg, cursor: 'pointer' }}
                  onMouseEnter={e => e.currentTarget.style.background = C.rowHover}
                  onMouseLeave={e => e.currentTarget.style.background = C.rowBg}
                  onClick={() => fetchVendorDetail(vendor.payee)}
                >
                  <td style={{ ...TD, width: 34, textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={mergeSelection.has(vendor.payee)}
                      onChange={() => toggleMergeSelect(vendor.payee)}
                      style={{ width: 15, height: 15, cursor: 'pointer', accentColor: RED }}
                      title="Select for merge"
                    />
                  </td>
                  <td style={{ ...TD, fontWeight: 700 }} onClick={e => e.stopPropagation()}>
                    {editingVendor === vendor.payee ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <input
                          type="text"
                          value={editName}
                          onChange={e => setEditName(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') handleRename(vendor.payee); if (e.key === 'Escape') setEditingVendor(null) }}
                          autoFocus
                          style={{ border: '1.5px solid ' + RED, borderRadius: 6, padding: '3px 8px', fontSize: 13, fontWeight: 700, color: C.text, background: C.inputBg, outline: 'none', width: 200, fontFamily: 'inherit' }}
                        />
                        <button onClick={() => handleRename(vendor.payee)} disabled={savingRename}
                          style={{ background: RED, color: '#fff', border: 'none', borderRadius: 5, padding: '4px 8px', cursor: 'pointer', display: 'flex' }}>
                          <Check style={{ width: 13, height: 13 }} />
                        </button>
                        <button onClick={() => setEditingVendor(null)}
                          style={{ background: C.elevBg, color: C.textMuted, border: '1px solid ' + C.border, borderRadius: 5, padding: '4px 8px', cursor: 'pointer', display: 'flex' }}>
                          <X style={{ width: 13, height: 13 }} />
                        </button>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ color: RED, cursor: 'pointer' }} onClick={() => fetchVendorDetail(vendor.payee)}>{vendor.payee}</span>
                        <button
                          onClick={() => { setEditingVendor(vendor.payee); setEditName(vendor.payee) }}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ccc', padding: 2, display: 'flex', transition: 'color 0.15s' }}
                          onMouseEnter={e => e.currentTarget.style.color = '#666'}
                          onMouseLeave={e => e.currentTarget.style.color = '#ccc'}
                          title="Rename vendor"
                        >
                          <Pencil style={{ width: 12, height: 12 }} />
                        </button>
                        {vendor.w9_mismatch && (
                          <span title={`W9 name: ${vendor.w9_name || 'unknown'}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, background: '#fef2f2', color: '#dc2626', padding: '1px 6px', borderRadius: 4, fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap' }}>
                            <AlertTriangle style={{ width: 10, height: 10 }} /> W9 mismatch
                          </span>
                        )}
                      </div>
                    )}
                  </td>
                  <td style={{ ...TD, textAlign: 'center', fontWeight: 600, color: '#555' }}>{vendor.invoice_count}</td>
                  <td style={{ ...TD, textAlign: 'right', fontWeight: 900, whiteSpace: 'nowrap' }}>{fmt(vendor.total_spent)}</td>
                  <td style={{ ...TD, color: '#9ca3af', fontWeight: 600, whiteSpace: 'nowrap' }}>{fmtDate(vendor.last_invoice)}</td>
                  <td style={{ ...TD, textAlign: 'center' }}>
                    {(() => {
                      const busy = uploadingW9For === vendor.payee
                      const over = w9DragOverFor === vendor.payee
                      return (
                        <div
                          onClick={e => { e.stopPropagation(); if (!busy) document.getElementById(`w9-input-row-${vendor.payee}`)?.click() }}
                          onDragOver={e => { e.preventDefault(); e.stopPropagation(); setW9DragOverFor(vendor.payee) }}
                          onDragLeave={e => { e.stopPropagation(); setW9DragOverFor(null) }}
                          onDrop={e => {
                            e.preventDefault(); e.stopPropagation(); setW9DragOverFor(null)
                            const file = e.dataTransfer.files?.[0]
                            if (file) uploadW9(vendor.payee, file)
                          }}
                          title={vendor.w9_on_file ? 'Drop a new W9 to replace' : 'Drop a W9 file here'}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 4,
                            border: `1.5px dashed ${over ? '#6366f1' : (vendor.w9_on_file ? C.badgeYesBg : C.badgeNoBg)}`,
                            borderRadius: 6, padding: '2px 8px', cursor: busy ? 'default' : 'pointer',
                            background: over ? '#eef2ff' : 'transparent',
                            fontSize: 11, fontWeight: 700,
                            color: vendor.w9_on_file ? C.badgeYesText : C.badgeNoText,
                            opacity: busy ? 0.5 : 1,
                          }}
                        >
                          {busy
                            ? <Loader style={{ width: 11, height: 11, animation: 'spin 0.8s linear infinite' }} />
                            : <Upload style={{ width: 11, height: 11 }} />}
                          {vendor.w9_on_file ? 'Yes' : 'No'}
                          <input
                            id={`w9-input-row-${vendor.payee}`}
                            type="file"
                            accept=".pdf,.png,.jpg,.jpeg"
                            style={{ display: 'none' }}
                            onChange={e => {
                              const file = e.target.files?.[0]
                              if (file) uploadW9(vendor.payee, file)
                              e.target.value = ''
                            }}
                          />
                        </div>
                      )
                    })()}
                  </td>
                  <td style={{ ...TD, textAlign: 'center' }}>
                    {parseFloat(vendor.total_spent_usd ?? vendor.total_spent ?? 0) >= 2000 ? (
                      <span style={{ ...W9_YES, background: '#fef9c3', color: '#92400e' }}>Qualifies</span>
                    ) : (
                      <span style={{ color: '#ccc', fontSize: 11 }}>—</span>
                    )}
                  </td>
                  <td style={{ ...TD, color: '#777' }}>{vendor.vendor_email || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
      {/* Merge selection bar — appears once 2+ vendors are checked */}
      {mergeSelection.size >= 2 && (
        <div
          className="fixed bottom-20 sm:bottom-6 left-1/2 -translate-x-1/2 z-40"
          style={{
            display: 'flex', alignItems: 'center', gap: 12, background: '#111827', color: '#fff',
            borderRadius: 12, boxShadow: '0 8px 30px rgba(0,0,0,.3)', padding: '10px 18px',
            maxWidth: 'calc(100vw - 1.5rem)', marginBottom: 'env(safe-area-inset-bottom)',
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 700 }}>{mergeSelection.size} vendors selected</span>
          <button
            onClick={() => { setBulkMergeTarget(''); setBulkMergeOpen(true) }}
            style={{ background: RED, color: '#fff', border: 'none', borderRadius: 8, padding: '7px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}
          >
            Merge…
          </button>
          <button
            onClick={() => setMergeSelection(new Set())}
            style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,.6)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
          >
            Clear
          </button>
        </div>
      )}

      {/* Merge target picker */}
      {bulkMergeOpen && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={() => !bulkMerging && setBulkMergeOpen(false)}
        >
          <div
            style={{ background: C.cardBg, borderRadius: 14, padding: 24, width: 480, maxWidth: '100%', maxHeight: '85dvh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.3)' }}
            onClick={e => e.stopPropagation()}
          >
            <h3 style={{ fontSize: 16, fontWeight: 800, color: C.text, margin: '0 0 4px' }}>Merge {mergeSelection.size} vendors</h3>
            <p style={{ fontSize: 12, color: C.textMuted, margin: '0 0 16px' }}>
              Pick the name that survives. Everything else merges into it — invoices are reassigned,
              old names become aliases, and saved emails follow. Prefer the spelling with a W9 on file.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 18 }}>
              {vendors
                .filter(v => mergeSelection.has(v.payee))
                .sort((a, b) => (b.w9_on_file ? 1 : 0) - (a.w9_on_file ? 1 : 0) || (b.invoice_count || 0) - (a.invoice_count || 0))
                .map(v => (
                  <label
                    key={v.payee}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                      border: `1.5px solid ${bulkMergeTarget === v.payee ? RED : C.border}`,
                      background: bulkMergeTarget === v.payee ? (C.isDark ? 'rgba(51, 65, 85,.08)' : '#fef2f2') : C.elevBg,
                      borderRadius: 10, cursor: 'pointer',
                    }}
                  >
                    <input
                      type="radio"
                      name="bulk-merge-target"
                      checked={bulkMergeTarget === v.payee}
                      onChange={() => setBulkMergeTarget(v.payee)}
                      style={{ accentColor: RED }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.payee}</div>
                      <div style={{ fontSize: 11, color: C.textFaint }}>
                        {v.invoice_count} invoice{v.invoice_count === 1 ? '' : 's'} · {fmt(v.total_spent)}{v.vendor_email ? ` · ${v.vendor_email}` : ''}
                      </div>
                    </div>
                    {v.w9_on_file
                      ? <span style={W9_YES}>W9 ✓</span>
                      : <span style={W9_NO}>No W9</span>}
                  </label>
                ))}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setBulkMergeOpen(false)}
                disabled={bulkMerging}
                style={{ background: C.elevBg, color: C.textMuted, border: '1px solid ' + C.border, borderRadius: 8, padding: '9px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
              >
                Cancel
              </button>
              <button
                onClick={runBulkMerge}
                disabled={!bulkMergeTarget || bulkMerging}
                style={{ background: RED, color: '#fff', border: 'none', borderRadius: 8, padding: '9px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', opacity: (!bulkMergeTarget || bulkMerging) ? 0.5 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                {bulkMerging && <Loader style={{ width: 13, height: 13, animation: 'spin 0.8s linear infinite' }} />}
                {bulkMerging ? 'Merging…' : bulkMergeTarget ? `Merge ${mergeSelection.size - 1} into "${bulkMergeTarget.slice(0, 24)}${bulkMergeTarget.length > 24 ? '…' : ''}"` : 'Pick the surviving name'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deckOpen && dupes.length > 0 && (
        <VendorDupeDeck
          pairs={dupes}
          onClose={() => setDeckOpen(false)}
          onChanged={() => { fetchVendors(); fetchDupes() }}
        />
      )}
      {previewFile && <FilePreview url={previewFile.url} filename={previewFile.filename} onClose={() => setPreviewFile(null)} />}
    </div>
  )
}
