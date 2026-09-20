import { useState, useEffect, useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Copy, Archive, RefreshCw, AlertTriangle, Tag, FileText, ChevronRight, X, Check, ExternalLink, Undo2, EyeOff, Eye, RotateCcw, Pencil, Loader, Landmark } from 'lucide-react'
import api from '../api'
import { formatDate } from '../utils'
import PageHeader from '../components/PageHeader'
import Skeleton from '../components/Skeleton'
import ListSearch, { matchesQuery } from '../components/ListSearch'
import ReviewDeck, { useDeckPreview } from '../components/ReviewDeck'
import InlineFilePreview from '../components/InlineFilePreview'
import FilePreview from '../components/FilePreview'
import { DOC_TYPES, pickDoc, fileUrl } from '../utils/entryFiles'
import { PAYMENT_METHODS } from '../constants'
import { useAuth } from '../context/AuthContext'

// The global Flags hub — served at /flags. (/duplicates redirects here; the
// filename is unchanged from when this page only did duplicate detection,
// same as ActivityHistory.jsx keeping its name after absorbing the history
// page. Don't rename it without updating App.jsx and Layout.jsx together.)
//
// Everything that flags something now surfaces in one place:
//   • catalog — duplicate releases / artists, missing genre / UPC / ISRC / Spotify
//   • ledger  — duplicate vendors + invoices, artist-column problems,
//               rows flagged by hand for review
//   • bank    — reconciliation flags from the statements engine, plus
//               transactions flagged during a review deck run
//
// Two rules the sections follow:
//   1. Sections that can fix a thing safely in place do (the merge flows).
//      Sections whose fix machinery already lives elsewhere deep-link to it
//      instead of forking that logic — see BankFlagsSection.
//   2. Visibility is layered: the page is permission-gated like any other, and
//      the money-shaped categories are additionally role-gated server-side
//      (routes/flags.js). Ledger flags need a bookkeeping role; bank flags
//      need Admin/Superadmin, matching the Statements page.
const SEVERITY_STYLE = {
  high:   { dot: 'bg-rose-500',   chip: 'bg-rose-50 text-rose-700 border-rose-200',     label: 'High'   },
  medium: { dot: 'bg-amber-500',  chip: 'bg-amber-50 text-amber-700 border-amber-200',  label: 'Medium' },
  low:    { dot: 'bg-blue-500',   chip: 'bg-blue-50 text-blue-700 border-blue-200',     label: 'Low'    },
}

// ── What kind of thing is this check? ───────────────────────────────────────
//
// The page used to announce "3419 potential issues" and show 22 identical
// cards, which made a mostly-complete catalogue look like a disaster and buried
// the things that cost money. One number was doing two jobs:
//
//   problem       something is WRONG — duplicated, contradictory, or flagged by
//                 a person. Someone has to make a decision. ~700 items.
//   completeness  a field is simply EMPTY. Bulk data entry, not a decision.
//                 ~2,700 items, dominated by ISRC / UPC / genre / Spotify.
//
// `group` drives the sidebar. Money first because a duplicated invoice costs
// real money; an empty ISRC does not.
const MONEY = 'Money', LEDGER = 'Ledger', CATALOG = 'Catalog', ARTISTS = 'Artists'
const GROUP_ORDER = [MONEY, LEDGER, CATALOG, ARTISTS]

// Module scope on purpose: MultiArtistCard has its own `fmtUsd`, but it is a
// component-local const and invisible here.
const usdRound = (n) => `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`

const CATEGORY_CLASS = {
  bank_flags:              { group: MONEY,   nature: 'problem' },
  paid_no_match:           { group: MONEY,   nature: 'problem' },
  unmatched_bank:          { group: MONEY,   nature: 'problem' },
  duplicate_payments:      { group: MONEY,   nature: 'problem' },
  duplicate_invoices:      { group: MONEY,   nature: 'problem' },
  duplicate_vendors:       { group: MONEY,   nature: 'problem' },
  flagged_expenses:        { group: MONEY,   nature: 'problem' },
  flagged_transactions:    { group: MONEY,   nature: 'problem' },

  artist_likely_typo:      { group: LEDGER,  nature: 'problem' },
  artist_song_mismatch:    { group: LEDGER,  nature: 'problem' },
  artist_unknown:          { group: LEDGER,  nature: 'problem' },
  artist_multi_name:       { group: LEDGER,  nature: 'problem' },
  artist_variants:         { group: LEDGER,  nature: 'problem' },
  artist_multi_normalize:  { group: LEDGER,  nature: 'problem' },
  artist_missing:          { group: LEDGER,  nature: 'completeness' },
  ledger_missing_song:     { group: LEDGER,  nature: 'completeness' },
  ledger_missing_socials:  { group: LEDGER,  nature: 'completeness' },

  duplicate_releases:      { group: CATALOG, nature: 'problem' },
  releases_missing_genre:  { group: CATALOG, nature: 'completeness' },
  releases_missing_upc:    { group: CATALOG, nature: 'completeness' },
  releases_missing_isrc:   { group: CATALOG, nature: 'completeness' },
  releases_missing_spotify:{ group: CATALOG, nature: 'completeness' },

  duplicate_artists:       { group: ARTISTS, nature: 'problem' },
  artists_missing_genre:   { group: ARTISTS, nature: 'completeness' },
  artists_missing_spotify: { group: ARTISTS, nature: 'completeness' },
}

// An unknown kind is treated as a PROBLEM and still rendered. Categories are
// defined server-side in routes/flags.js, so a new check added there must show
// up here rather than silently vanish because this map hadn't heard of it.
const classify = (kind) => CATEGORY_CLASS[kind] || { group: LEDGER, nature: 'problem' }
const isProblem = (cat) => classify(cat.kind).nature === 'problem'

// Shorter labels for the sidebar. The full label stays on the section header;
// "Potential Duplicate Releases" in a 200px rail just truncates.
const SHORT_LABEL = {
  bank_flags: 'Reconciliation',
  paid_no_match: 'Paid, no bank match',
  unmatched_bank: 'Statement item, not in the ledger',
  duplicate_payments: 'One payment, two ledger rows',
  duplicate_invoices: 'Duplicate invoices',
  duplicate_vendors: 'Duplicate vendors',
  duplicate_releases: 'Duplicate releases',
  duplicate_artists: 'Duplicate artists',
  flagged_expenses: 'Flagged expenses',
  flagged_transactions: 'Flagged transactions',
  artist_multi_normalize: 'Multi-artist rows',
  artist_likely_typo: 'Likely typo',
  artist_song_mismatch: 'Artist ↔ song',
  artist_unknown: 'Unknown artist',
  artist_multi_name: 'Multiple artists',
  artist_variants: 'Spelling variants',
  artist_missing: 'Missing artist',
  ledger_missing_song: 'Missing song',
  ledger_missing_socials: 'Missing socials',
  releases_missing_genre: 'Genre',
  releases_missing_upc: 'UPC',
  releases_missing_isrc: 'ISRC',
  releases_missing_spotify: 'Spotify link',
  artists_missing_genre: 'Genre',
  artists_missing_spotify: 'Spotify link',
}
const shortLabel = (cat) => SHORT_LABEL[cat.kind] || cat.label

export default function Duplicates() {
  const { user } = useAuth()
  const isAdmin = (user?.hierarchy_level ?? 99) <= 2

  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [mergeKeepIds, setMergeKeepIds] = useState({})
  const [artistMergeKeepIds, setArtistMergeKeepIds] = useState({})
  // Vendor merge keep-target — keyed by group index in the
  // duplicate_vendors bucket. Value is the chosen canonical payee
  // STRING (vendors aren't first-class rows, so we key by name).
  const [vendorMergeKeepNames, setVendorMergeKeepNames] = useState({})
  // Names to LEAVE ALONE in a merge, keyed by group index. Fuzzy matching pulls
  // genuine third parties into a group — "Druz Media, LLC" landing beside
  // "Prulo Media LLC" / "Prulo Media" — and merging all-or-nothing meant either
  // renaming a real vendor or dismissing the whole group and fixing nothing.
  const [vendorMergeExcluded, setVendorMergeExcluded] = useState({})
  const [mergingKey, setMergingKey] = useState(null)
  // Multi-artist normalization — key of the group being applied so the
  // section can render a loading state on just that card while others
  // stay interactive.
  const [multiArtistBusyKey, setMultiArtistBusyKey] = useState(null)
  // Full artists list for the typeahead in the multi-artist section.
  // Lazy-loaded on first open; each entry is { id, name }.
  const [allArtists, setAllArtists] = useState([])
  const [archivingReleaseId, setArchivingReleaseId] = useState(null)
  // Artist-flag UI state
  const [showLow, setShowLow] = useState(false) // hide low-severity by default per design
  const [dismissedRows, setDismissedRows] = useState([])
  const [showDismissed, setShowDismissed] = useState(false)
  const [busyEntryId, setBusyEntryId] = useState(null)
  // Invoice preview overlay — single-file mode for a per-row Invoice button,
  // multi-file mode for the "View all" button at the top of unknown-artist
  // tabs. Cleared by FilePreview's onClose.
  const [previewFile, setPreviewFile] = useState(null)
  const [previewFiles, setPreviewFiles] = useState(null) // array form

  // Split modal — opens on the "Split" row action. Lets the user divide a
  // single ledger entry into N artist-specific child rows via POST
  // /bk/entries/:id/split. Pre-fills from artist_multi_name's parsed
  // suggestion when present; otherwise starts with two blank rows so the
  // user can type the artists they want to split between.
  const [splitModal, setSplitModal] = useState(null) // { kind, row, rows: [{artist, song, amount}] }
  const [splitSaving, setSplitSaving] = useState(false)
  const openSplitModal = (kind, row) => {
    const total = Number(row.amount) || 0
    const sug = row.suggestion
    let seedNames = []
    if (kind === 'artist_multi_name' && Array.isArray(sug) && sug.length >= 2) {
      seedNames = sug.map(s => String(s))
    } else if (row.artist) {
      seedNames = [row.artist, '']
    } else {
      seedNames = ['', '']
    }
    // Distribute the original amount equally, putting any leftover cents on
    // the first row so the family total matches the original to the penny.
    const per = total ? Math.floor((total / seedNames.length) * 100) / 100 : 0
    const leftover = total ? Math.round((total - per * seedNames.length) * 100) / 100 : 0
    const initialRows = seedNames.map((name, i) => ({
      artist: name,
      song: row.song || '',
      amount: total ? String((i === 0 ? per + leftover : per).toFixed(2)) : '',
    }))
    setSplitModal({ kind, row, rows: initialRows })
  }
  const updateSplitRow = (idx, field, value) => {
    setSplitModal(prev => prev && {
      ...prev,
      rows: prev.rows.map((r, i) => i === idx ? { ...r, [field]: value } : r),
    })
  }
  const addSplitRow = () => {
    setSplitModal(prev => prev && {
      ...prev,
      rows: [...prev.rows, { artist: '', song: prev.row.song || '', amount: '' }],
    })
  }
  const removeSplitRow = (idx) => {
    setSplitModal(prev => prev && {
      ...prev,
      rows: prev.rows.length > 2 ? prev.rows.filter((_, i) => i !== idx) : prev.rows,
    })
  }
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
      // Server-side: original row is now the parent; N child rows live under
      // it. The parent's artist field is set to the first split (per the
      // existing split endpoint). Dismiss the flag for the parent so it
      // drops out of the bucket on next refresh.
      await api.post('/flags/artist-issues/dismiss', {
        entry_id: splitModal.row.id,
        flag_kind: toServerFlagKind(splitModal.kind),
      }).catch(() => {})
      stripFlag(splitModal.kind, splitModal.row.id)
      setSplitModal(null)
    } catch (e) {
      alert('Split failed: ' + (e.response?.data?.error || e.message))
    } finally {
      setSplitSaving(false)
    }
  }

  // Active sub-page persisted in the URL so tabs are bookmarkable / shareable
  // / survive a refresh.
  const [searchParams, setSearchParams] = useSearchParams()
  const activeTab = searchParams.get('tab') || 'overview'
  const setTab = (kind) => setSearchParams(prev => {
    const next = new URLSearchParams(prev)
    if (kind === 'overview') next.delete('tab'); else next.set('tab', kind)
    return next
  }, { replace: true })

  const fetch = async (showSpinner = true) => {
    if (showSpinner) setLoading(true)
    else setRefreshing(true)
    try {
      // Include group-level dismissals when the toggle is on so the
      // duplicate-flag tabs surface dismissed groups (greyed out + restore
      // button) alongside live ones.
      const qs = showDismissed ? '?include_dismissed=1' : ''
      // Reconciliation flags come from the statements engine, not /flags —
      // a separate request on purpose. That endpoint runs a heavy set of
      // sweeps and is gated to Admin/Superadmin, so keeping it separate means
      // (a) the 403 for everyone else costs nothing and doesn't take the rest
      // of the hub down with it, and (b) the sweeps aren't run for viewers who
      // wouldn't be allowed to see the result anyway.
      const [res, bankRes, unmatchedRes, dupPairRes] = await Promise.all([
        api.get(`/flags${qs}`),
        api.get('/statements/flags').catch(() => null),
        // Separate from the flags sweep on purpose — see the route comment.
        // Same `.catch(null)`: a non-admin 403 must not take the hub down.
        api.get(`/statements/unmatched?limit=250${showDismissed ? '&include_dismissed=1' : ''}`).catch(() => null),
        // One payment, two ledger rows — a paid invoice with no bank match
        // sitting beside a same-payee/same-amount row that has one. Same
        // `.catch(null)` as its siblings: a non-admin 403 must not take the
        // hub down.
        api.get('/statements/duplicate-pairs').catch(() => null),
      ])
      const cats = res.data.data || []
      const bank = bankRes?.data?.data
      const bankFlags = Array.isArray(bank) ? bank : (bank?.flags || [])
      // "Paid but never seen leaving the bank" gets its own subpage. It was the
      // single largest reconciliation flag type and sat mixed in with nine
      // others, so the one question people actually ask of the ledger — does
      // everything we've marked Paid actually appear on a statement? — had no
      // place to be asked.
      //
      // The engine only raises this where a statement genuinely COVERS the
      // payment date (±3 days) and the method suits that account, so a PayPal
      // payment is never flagged against a BofA-only period.
      const paidNoMatch = bankFlags.filter(f => f.type === 'paid-no-match')
      const otherBank = bankFlags.filter(f => f.type !== 'paid-no-match')

      if (paidNoMatch.length) {
        // The engine attaches at most 150 of these; `counts.paid_no_match` is
        // the real figure. Showing the attached count as though it were the
        // total would understate it on the very page meant to surface it.
        const total = Number(bank?.counts?.paid_no_match) || paidNoMatch.length
        const trimmed = total > paidNoMatch.length
        cats.push({
          kind: 'paid_no_match',
          label: 'Paid — no bank match',
          description: 'Ledger entries marked Paid that never appear leaving the bank, where a statement covering that date HAS been uploaded and the payment method suits that account. Either the payment date or method is wrong, it was paid from an account with no statement, or it was never actually paid.'
            + (trimmed ? ` Showing the largest ${paidNoMatch.length} of ${total}.` : ''),
          severity: 'high',
          items: paidNoMatch,
          count: total,
        })
      }

      // The mirror image of paid_no_match: that asks "does everything we marked
      // Paid appear on a statement?", this asks "does everything on the
      // statement appear in the ledger?". Both questions are needed to trust
      // the books, and only one of them had a home.
      //
      // Not every row will ever have a ledger match — bank fees, an owner
      // transfer, a personal charge — so dismissing is a first-class answer
      // here, not an escape hatch.
      const um = unmatchedRes?.data?.data
      if (um && (um.rows || []).length) {
        const c = um.counts || {}
        const shown = (um.rows || []).filter(r => !r.dismissed).length
        cats.push({
          kind: 'unmatched_bank',
          label: 'On the statement — not in the ledger',
          description: 'Bank transactions no ledger entry accounts for. '
            + `${c.debits || 0} money out${c.debit_usd ? ` (${usdRound(c.debit_usd)})` : ''}`
            + `, ${c.credits || 0} money in${c.credit_usd ? ` (${usdRound(c.credit_usd)})` : ''}.`
            + ' Book it, match it to an invoice, or dismiss it — not everything on a statement belongs in the ledger.'
            + (um.truncated ? ` Showing the largest ${shown} by value.` : ''),
          severity: 'high',
          items: um.rows,
          count: c.total || shown,
          dismissed_count: c.dismissed || 0,
        })
      }

      // One payment, two ledger rows. Booking a bank row used to create a new
      // entry even when the paid invoice was already sitting there, so the
      // payment ended up recorded twice: once as the real invoice (with the
      // file, the invoice number, the artist) and once as a statement stub that
      // holds the bank match. create-entry refuses to do that now; this is the
      // backlog it left behind.
      const dp = dupPairRes?.data?.data
      if (dp && (dp.pairs || []).length) {
        cats.push({
          kind: 'duplicate_payments',
          label: 'One payment, two ledger rows',
          description: `${dp.count} payment${dp.count === 1 ? '' : 's'}`
            + `${dp.total ? ` (${usdRound(dp.total)})` : ''} appear twice in the ledger — a paid invoice with `
            + 'no bank match, next to a same-payee, same-amount row that holds the match. '
            + 'Merging keeps the invoice and its documents, moves the bank match onto it, and '
            + 'archives the duplicate. Review them one at a time — a vendor who genuinely billed '
            + 'twice for the same amount looks identical.',
          severity: 'high',
          items: dp.pairs,
          count: dp.count,
        })
      }

      if (otherBank.length) {
        cats.push({
          kind: 'bank_flags',
          label: 'Statements — Reconciliation',
          description: 'Other bank-vs-ledger problems found by the statements engine: booked twice, double-funded legs, amount and date drift, stale coverage. Each one deep-links to its one-click fix on the Statements page.',
          // Errors are real double-counts; warnings are "look at this".
          severity: otherBank.some(f => f.severity === 'error') ? 'high' : 'medium',
          items: otherBank,
          count: otherBank.length,
        })
      }
      setCategories(cats)
    } catch {
      setCategories([])
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }
  useEffect(() => { fetch(true) }, [])
  // Re-fetch when the show-dismissed toggle changes so the server can
  // include / exclude the dismissed groups from the main list.
  useEffect(() => { fetch(false) }, [showDismissed])

  // Full artists roster for the multi-artist typeahead. One-shot load
  // — the list is small enough (hundreds of rows at most) that the
  // typeahead can filter client-side without a per-keystroke request.
  useEffect(() => {
    api.get('/artists?limit=5000')
      .then(r => {
        const rows = Array.isArray(r.data) ? r.data
          : Array.isArray(r.data?.data) ? r.data.data
          : []
        setAllArtists(rows.map(a => ({ id: a.id, name: a.name })).filter(a => a.name))
      })
      .catch(() => setAllArtists([]))
  }, [])

  // Apply a multi-artist normalization. Server bulk-renames existing
  // rows AND stores the mapping so future rows auto-collapse. Local
  // state removes the group from the flag list since it no longer
  // has any expenses.
  const handleApplyMultiArtist = async ({ source, base, base_artist_id }) => {
    setMultiArtistBusyKey(source.toLowerCase())
    try {
      const { data } = await api.post('/flags/artist-multi/apply', {
        source, base, base_artist_id: base_artist_id ?? null,
      })
      setCategories(prev => prev.map(c => {
        if (c.kind !== 'artist_multi_normalize') return c
        const nextGroups = (c.groups || []).filter(g => g.source_key !== source.toLowerCase())
        return { ...c, groups: nextGroups, count: nextGroups.length }
      }))
      return { ok: true, renamed: data?.data?.renamed || 0 }
    } catch (err) {
      return { ok: false, error: err?.response?.data?.error || err.message }
    } finally {
      setMultiArtistBusyKey(null)
    }
  }

  // Lazy-load dismissed artist-flag rows only when the user toggles them on.
  useEffect(() => {
    if (!showDismissed) return
    api.get('/flags/artist-issues?include_dismissed=1')
      .then(r => setDismissedRows(r.data.data?.dismissed || []))
      .catch(() => setDismissedRows([]))
  }, [showDismissed])

  // Group-level dismiss/restore — works for duplicate releases / artists /
  // vendors. Optimistically removes the group from the current view, with
  // a refetch on failure to re-sync.
  const toggleGroupDismiss = async (kind, groupKey, value) => {
    try {
      await api.post('/flags/group/dismiss', { kind, group_key: groupKey, value })
      // Refetch to keep the group counts + the show-dismissed view honest.
      // Cheaper to refetch the whole /flags response than reconcile the
      // partition state inline.
      fetch(false)
    } catch (e) {
      alert('Failed: ' + (e.response?.data?.error || e.message))
    }
  }

  // Ledger-row flag categories (server returns these inside the same /flags
  // payload). The Map encodes category kind -> the underlying flag_kind that
  // the dismiss/restore endpoints expect (server stores the latter in
  // flag_dismissals.flag_kind).
  const LEDGER_FLAG_KINDS = new Map([
    ['artist_likely_typo',     'likely_typo'],
    ['artist_song_mismatch',   'song_mismatch'],
    ['artist_unknown',         'unknown'],
    ['artist_multi_name',      'multi_name'],
    ['artist_missing',         'missing'],
    ['artist_placeholder',     'placeholder'],
    ['artist_variants',        'variants'],
    ['ledger_missing_song',    'missing_song'],
    ['ledger_missing_socials', 'missing_socials'],
  ])
  const isLedgerFlagKind = (k) => LEDGER_FLAG_KINDS.has(k)
  const toServerFlagKind = (k) => LEDGER_FLAG_KINDS.get(k) || k

  // Remove a single flagged row from local state after a dismiss or fix.
  const stripFlag = (kind, entryId) => {
    setCategories(prev => prev.map(c => {
      if (c.kind !== kind) return c
      const items = (c.items || []).filter(it => it.id !== entryId)
      return { ...c, items, count: items.length }
    }))
  }

  const dismissArtistFlag = async (kind, entryId) => {
    const flagKind = toServerFlagKind(kind)
    setBusyEntryId(entryId)
    try {
      await api.post('/flags/artist-issues/dismiss', { entry_id: entryId, flag_kind: flagKind })
      stripFlag(kind, entryId)
    } catch (e) { alert('Dismiss failed: ' + (e.response?.data?.error || e.message)) }
    finally { setBusyEntryId(null) }
  }

  const restoreArtistFlag = async (entryId, flagKind) => {
    setBusyEntryId(entryId)
    try {
      await api.post('/flags/artist-issues/restore', { entry_id: entryId, flag_kind: flagKind })
      setDismissedRows(prev => prev.filter(r => !(r.entry_id === entryId && r.flag_kind === flagKind)))
      // Re-scan so the row reappears in its category bucket.
      fetch(false)
    } catch (e) { alert('Restore failed: ' + (e.response?.data?.error || e.message)) }
    finally { setBusyEntryId(null) }
  }

  // After applying a fix, the row hangs around in a 'pending' state for a
  // few seconds — dimmed + line-through, with an Undo button — before
  // fading out for good. Lets the user reverse a bad fix without re-finding
  // the row. Keyed by entryId+kind so the same row can have multiple
  // independent fixes pending across categories.
  const [pendingFixes, setPendingFixes] = useState({}) // { 'entryId:kind': { field, oldValue, newValue, timerId } }
  const PENDING_MS = 5000

  const queuePending = (kind, entryId, field, oldValue, newValue) => {
    const key = `${entryId}:${kind}`
    const timerId = setTimeout(() => {
      stripFlag(kind, entryId)
      setPendingFixes(prev => {
        const next = { ...prev }
        delete next[key]
        return next
      })
    }, PENDING_MS)
    setPendingFixes(prev => {
      // If there's already a pending fix for this row+kind, clear its timer
      // first so we don't double-strip.
      if (prev[key]?.timerId) clearTimeout(prev[key].timerId)
      return { ...prev, [key]: { field, oldValue, newValue, timerId } }
    })
  }

  // Undo the last fix for a row. Restores the old value, restores the
  // server-side dismissal (so the flag reappears next refresh), and
  // cancels the auto-strip timer.
  const undoFix = async (kind, entryId) => {
    const key = `${entryId}:${kind}`
    const pf = pendingFixes[key]
    if (!pf) return
    clearTimeout(pf.timerId)
    setBusyEntryId(entryId)
    try {
      await api.put(`/bk/entries/${entryId}`, { [pf.field]: pf.oldValue || null })
      await api.post('/flags/artist-issues/restore', { entry_id: entryId, flag_kind: toServerFlagKind(kind) }).catch(() => {})
      setCategories(prev => prev.map(c => {
        if (c.kind !== kind) return c
        const items = (c.items || []).map(it =>
          it.id === entryId ? { ...it, [pf.field]: pf.oldValue || '' } : it
        )
        return { ...c, items }
      }))
    } catch (e) { alert('Undo failed: ' + (e.response?.data?.error || e.message)) }
    setPendingFixes(prev => { const next = { ...prev }; delete next[key]; return next })
    setBusyEntryId(null)
  }

  // One-click apply: PUT the new artist on the ledger row, dismiss the
  // flag, and queue a pending-removal so the row fades out with an Undo
  // affordance instead of disappearing instantly.
  const applyArtistFix = async (kind, entryId, newArtist) => {
    const flagKind = toServerFlagKind(kind)
    const cat = categories.find(c => c.kind === kind)
    const row = cat?.items?.find(r => r.id === entryId)
    const oldValue = row?.artist || ''
    setBusyEntryId(entryId)
    try {
      await api.put(`/bk/entries/${entryId}`, { artist: newArtist })
      await api.post('/flags/artist-issues/dismiss', { entry_id: entryId, flag_kind: flagKind }).catch(() => {})
      // Show the row in its new state during the fade — reflect the change locally.
      setCategories(prev => prev.map(c => c.kind !== kind ? c : {
        ...c,
        items: (c.items || []).map(it => it.id === entryId ? { ...it, artist: newArtist } : it),
      }))
      queuePending(kind, entryId, 'artist', oldValue, newArtist)
    } catch (e) { alert('Fix failed: ' + (e.response?.data?.error || e.message)) }
    finally { setBusyEntryId(null) }
  }

  // Inline-fix for missing-field flags. Same pending-fade + Undo flow.
  const applyMissingFieldFix = async (kind, entryId, value) => {
    const next = (value || '').trim()
    if (!next) return
    const field = kind === 'ledger_missing_song' ? 'song' : 'artist'
    const flagKind = toServerFlagKind(kind)
    const cat = categories.find(c => c.kind === kind)
    const row = cat?.items?.find(r => r.id === entryId)
    const oldValue = row?.[field] || ''
    setBusyEntryId(entryId)
    try {
      await api.put(`/bk/entries/${entryId}`, { [field]: next })
      await api.post('/flags/artist-issues/dismiss', { entry_id: entryId, flag_kind: flagKind }).catch(() => {})
      setCategories(prev => prev.map(c => c.kind !== kind ? c : {
        ...c,
        items: (c.items || []).map(it => it.id === entryId ? { ...it, [field]: next } : it),
      }))
      queuePending(kind, entryId, field, oldValue, next)
    } catch (e) { alert('Fix failed: ' + (e.response?.data?.error || e.message)) }
    finally { setBusyEntryId(null) }
  }

  // Clear a placeholder out of the artist field.
  //
  // Deliberately NOT a mode of applyMissingFieldFix: that function bails on an
  // empty value ("if (!next) return"), and rightly so — for every other flag
  // here, blank is the problem being fixed. On a placeholder row blank is the
  // ANSWER. 22 of the 24 live rows are Salary, Rent, Studio House and Legal,
  // where the spend genuinely belongs to no artist; "n/a" states an attribution
  // no report agrees with, so removing it makes the row honest rather than
  // incomplete.
  const clearArtistField = async (kind, entryId) => {
    const cat = categories.find(c => c.kind === kind)
    const row = cat?.items?.find(r => r.id === entryId)
    const oldValue = row?.artist || ''
    if (!confirm(`Clear "${oldValue}" from the artist field?\n\nThe row keeps its category and amount and simply stops naming an artist — which is what the P&L and Spend by Artist already assume. Use this when the spend genuinely isn't for one artist.`)) return
    setBusyEntryId(entryId)
    try {
      await api.put(`/bk/entries/${entryId}`, { artist: '' })
      await api.post('/flags/artist-issues/dismiss', { entry_id: entryId, flag_kind: toServerFlagKind(kind) }).catch(() => {})
      setCategories(prev => prev.map(c => c.kind !== kind ? c : {
        ...c,
        items: (c.items || []).map(it => it.id === entryId ? { ...it, artist: '' } : it),
      }))
      queuePending(kind, entryId, 'artist', oldValue, '')
    } catch (e) { alert('Fix failed: ' + (e.response?.data?.error || e.message)) }
    finally { setBusyEntryId(null) }
  }

  // Categories visible after the low-severity filter; low-severity tabs (and
  // their counts) are hidden unless the user opts in. Active-category lookup
  // still uses the full list so a deep-linked low-severity tab survives.
  const visibleCategories = useMemo(
    () => showLow ? categories : categories.filter(c => c.severity !== 'low'),
    [categories, showLow],
  )
  const totalFlags = visibleCategories.reduce((s, c) => s + (c.count || 0), 0)
  const activeCategory = useMemo(
    () => categories.find(c => c.kind === activeTab) || null,
    [categories, activeTab],
  )

  // The two headline figures, derived from the classification so they always
  // add up to the same total the API reported — nothing can be dropped by a
  // category this page doesn't recognise.
  const problemCount = useMemo(
    () => visibleCategories.filter(isProblem).reduce((s, c) => s + (c.count || 0), 0),
    [visibleCategories],
  )
  const incompleteCount = totalFlags - problemCount

  // Sidebar model: groups in a fixed order, each with its categories sorted
  // problems-first then by size. Empty groups drop out entirely.
  const navGroups = useMemo(() => GROUP_ORDER.map(name => ({
    name,
    cats: visibleCategories
      .filter(c => classify(c.kind).group === name)
      .sort((a, b) => (isProblem(b) - isProblem(a)) || (b.count || 0) - (a.count || 0)),
  })).filter(g => g.cats.length), [visibleCategories])

  // ── Search within the active section ──────────────────────────────────────
  // The hub now spans catalog, ledger and bank flags, and a single section can
  // run to hundreds of rows. Row SHAPES differ per section (releases, artists,
  // vendors, invoices, ledger rows, bank flags) and sections come as either
  // `items` or `groups`, so rather than teach each renderer to filter, the
  // active category is filtered before it reaches CategoryBody — every section
  // gets search for free and none of them changed.
  const [flagQ, setFlagQ] = useState('')
  // Clear the query when the section changes. Keyed on activeTab (which lives
  // in the URL) so back/forward navigation resets it too — otherwise you open a
  // section and it reads "nothing matches" because of a query you typed
  // somewhere else.
  useEffect(() => { setFlagQ('') }, [activeTab])
  // Collect the human-readable primitives from a row, at any depth (groups nest
  // their members). Identifier-ish keys are skipped: without that, a query like
  // "3" matches nearly everything via ids, which makes the filter useless.
  const searchableValues = (node, depth = 0, out = []) => {
    if (node == null || depth > 4) return out
    if (typeof node === 'string' || typeof node === 'number') { out.push(node); return out }
    if (Array.isArray(node)) { for (const v of node) searchableValues(v, depth + 1, out); return out }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === 'id' || k.endsWith('_id') || k === 'group_key' || k === 'source_key'
          || k === 'fingerprint' || k === 'kind' || k === 'severity') continue
        searchableValues(v, depth + 1, out)
      }
    }
    return out
  }
  const filteredCategory = useMemo(() => {
    if (!activeCategory || !flagQ.trim()) return activeCategory
    const next = { ...activeCategory }
    if (Array.isArray(next.items)) {
      next.items = next.items.filter(i => matchesQuery(flagQ, searchableValues(i)))
    }
    if (Array.isArray(next.groups)) {
      next.groups = next.groups.filter(g => matchesQuery(flagQ, searchableValues(g)))
    }
    return next
  }, [activeCategory, flagQ]) // eslint-disable-line react-hooks/exhaustive-deps
  const activeShown = filteredCategory
    ? (filteredCategory.items?.length ?? filteredCategory.groups?.length ?? 0)
    : 0
  const activeTotal = activeCategory
    ? (activeCategory.items?.length ?? activeCategory.groups?.length ?? 0)
    : 0

  // ── Mutations ─────────────────────────────────────────────────────────────
  const handleArchiveRelease = async (releaseId) => {
    setArchivingReleaseId(releaseId)
    try {
      await api.put(`/releases/${releaseId}/archive`)
      setCategories(prev => prev.map(c => c.kind !== 'duplicate_releases' ? c : (() => {
        const groups = (c.groups || []).map(g => ({ ...g, releases: g.releases.filter(r => r.id !== releaseId) }))
          .filter(g => g.releases.length >= 2)
        return { ...c, groups, count: groups.length }
      })()))
    } catch { alert('Failed to archive') }
    finally { setArchivingReleaseId(null) }
  }

  const handleMergeReleases = async (idx, group) => {
    const targetId = mergeKeepIds[idx]
    if (!targetId) return
    const sourceIds = group.releases.map(r => r.id).filter(id => id !== targetId)
    if (!sourceIds.length) return
    const target = group.releases.find(r => r.id === targetId)
    if (!window.confirm(`Merge ${sourceIds.length} release${sourceIds.length === 1 ? '' : 's'} into "${target?.project_name || 'selected'}"? The other ${sourceIds.length} will be permanently deleted.`)) return
    setMergingKey(`dup_rel:${idx}`)
    try {
      await api.post('/releases/merge', { target_id: targetId, source_ids: sourceIds })
      setCategories(prev => prev.map(c => c.kind === 'duplicate_releases'
        ? { ...c, groups: c.groups.filter((_, i) => i !== idx), count: c.groups.length - 1 }
        : c))
      setMergeKeepIds(prev => { const n = { ...prev }; delete n[idx]; return n })
    } catch (err) { alert('Merge failed: ' + (err.response?.data?.error || err.message)) }
    finally { setMergingKey(null) }
  }

  const handleMergeArtists = async (idx, group) => {
    const targetId = artistMergeKeepIds[idx] ?? group[0]?.id
    if (!targetId) return
    const sourceIds = group.map(a => a.id).filter(id => id !== targetId)
    if (!sourceIds.length) return
    const target = group.find(a => a.id === targetId)
    if (!window.confirm(`Merge ${sourceIds.length} artist${sourceIds.length === 1 ? '' : 's'} into "${target?.name}"? Their releases, contracts, and expenses will be reassigned and the source rows deleted.`)) return
    setMergingKey(`dup_art:${idx}`)
    try {
      for (const fromId of sourceIds) {
        await api.post('/artists/merge', { from_id: fromId, to_id: targetId })
      }
      setCategories(prev => prev.map(c => c.kind === 'duplicate_artists'
        ? { ...c, groups: c.groups.filter((_, i) => i !== idx), count: c.groups.length - 1 }
        : c))
      setArtistMergeKeepIds(prev => { const n = { ...prev }; delete n[idx]; return n })
    } catch (err) { alert('Merge failed: ' + (err.response?.data?.error || err.message)) }
    finally { setMergingKey(null) }
  }

  // Inline rename — patches artists.name + cascades to string-keyed
  // references (expenses.artist, deals.artist_name, artist_income.
  // artist_name). Returns a boolean so the child component can hand
  // back "did it succeed" without threading toast state through.
  // Updates local categories state on success so the group re-renders
  // with the new name and users can decide whether the merge is still
  // needed. Returns { ok: true } / { ok: false, error }.
  const handleRenameArtist = async (id, newName) => {
    const trimmed = String(newName || '').trim()
    if (!trimmed) return { ok: false, error: 'Name is required' }
    try {
      const { data } = await api.patch(`/artists/${id}/name`, { name: trimmed })
      // Update the artist name in EVERY group / category — the same
      // artist could theoretically appear in more than one duplicate
      // group and we don't want a stale spelling lingering elsewhere.
      setCategories(prev => prev.map(c => {
        if (c.kind !== 'duplicate_artists') return c
        return {
          ...c,
          groups: (c.groups || []).map(g => {
            const artists = Array.isArray(g) ? g : (g.artists || [])
            const nextArtists = artists.map(a => a.id === id ? { ...a, name: trimmed } : a)
            return Array.isArray(g) ? nextArtists : { ...g, artists: nextArtists }
          }),
        }
      }))
      return { ok: true, data: data?.data }
    } catch (err) {
      return { ok: false, error: err?.response?.data?.error || err.message }
    }
  }

  // Vendor merge: rename every expense from the source payee strings to the
  // target payee, then add each source as an alias of the target. The server
  // does this atomically per source via POST /bk/vendors/merge.
  const handleMergeVendors = async (idx, group) => {
    const targetName = vendorMergeKeepNames[idx] ?? group[0]?.payee
    if (!targetName) return
    const excluded = new Set(vendorMergeExcluded[idx] || [])
    const sources = group.map(v => v.payee).filter(p => p !== targetName && !excluded.has(p))
    if (!sources.length) return
    // Name the vendors, don't just count them — this renames every expense
    // under each one, and the whole point of excluding a member is that the
    // list is not obvious from the group.
    if (!window.confirm(
      `Merge into "${targetName}"?\n\n${sources.map(x => `  • ${x}`).join('\n')}\n\n`
      + `Every expense under ${sources.length === 1 ? 'that name' : 'those names'} is renamed to "${targetName}", and `
      + `${sources.length === 1 ? 'the old name is' : 'the old names are'} kept as ${sources.length === 1 ? 'an alias' : 'aliases'}.`
      + (excluded.size ? `\n\nLeft alone: ${[...excluded].join(', ')}` : ''))) return
    setMergingKey(`dup_vend:${idx}`)
    try {
      for (const source of sources) {
        await api.post('/bk/vendors/merge', { source, target: targetName })
      }
      if (excluded.size) {
        // Some names stayed behind, so the group may still exist (with fewer
        // members) — ask the server rather than guess what's left.
        await fetch(false)
      } else {
        setCategories(prev => prev.map(c => c.kind === 'duplicate_vendors'
          ? { ...c, groups: c.groups.filter((_, i) => i !== idx), count: c.groups.length - 1 }
          : c))
      }
      setVendorMergeKeepNames(prev => { const n = { ...prev }; delete n[idx]; return n })
      setVendorMergeExcluded(prev => { const n = { ...prev }; delete n[idx]; return n })
    } catch (err) { alert('Merge failed: ' + (err.response?.data?.error || err.message)) }
    finally { setMergingKey(null) }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton.PageHeader />
        <Skeleton.Block h="h-12" />
        <Skeleton.Block h="h-32" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader tour="flags-header"
        title="Flags"
        // Two figures, never one. "3419 potential issues" conflated 700 things
        // that are wrong with 2,700 empty fields, so the page read as a
        // disaster and the money items were invisible among the metadata.
        //
        // The category description no longer replaces this — it moves to the
        // section header, so the page keeps its anchor when you open a section.
        subtitle={
          totalFlags === 0
            ? 'Nothing flagged.'
            : [
                problemCount ? `${problemCount.toLocaleString()} need${problemCount === 1 ? 's' : ''} a decision` : null,
                incompleteCount ? `${incompleteCount.toLocaleString()} field${incompleteCount === 1 ? '' : 's'} incomplete` : null,
              ].filter(Boolean).join(' · ')
        }
        actions={
          <button
            onClick={() => fetch(false)}
            disabled={refreshing}
            title="Re-scan for flags"
            className="p-1.5 text-gray-300 hover:text-boom-600 rounded-lg hover:bg-boom-50 transition-colors disabled:opacity-40"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
          </button>
        }
      />

      {/* Section picker for narrow screens. The old strip was an
          overflow-x-auto row of 22 tabs — five visible at a time and worst on
          mobile, where a horizontal scroller inside a vertical page is close to
          undiscoverable. */}
      <div className="lg:hidden">
        <select
          value={activeTab}
          onChange={(e) => setTab(e.target.value)}
          className="w-full border border-rule rounded-lg px-3 py-2 text-[13px] bg-card text-ink"
        >
          <option value="overview">Overview{totalFlags ? ` · ${totalFlags}` : ''}</option>
          {navGroups.map(g => (
            <optgroup key={g.name} label={g.name}>
              {g.cats.map(c => (
                <option key={c.kind} value={c.kind}>{shortLabel(c)} · {c.count}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      {/* Two columns from lg up: a grouped rail on the left, body on the right.
          The rail replaces a 22-tab horizontal scroller — the categories span
          four unrelated domains (money, ledger, catalog, artists) and grouping
          them is the only way the list reads as structure rather than a pile. */}
      <div className="lg:flex lg:items-start lg:gap-6">
        <FlagsNav
          groups={navGroups}
          activeTab={activeTab}
          onPick={setTab}
          totalFlags={totalFlags}
        />

        <div className="flex-1 min-w-0 space-y-4">
      {/* Toggle row — show-low + show-dismissed live above the body so they
          apply across every section. */}
      <div className="flex items-center gap-4">
        <button
          onClick={() => setShowLow(v => !v)}
          className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-gray-500 hover:text-gray-800"
        >
          {showLow ? <EyeOff size={12} /> : <Eye size={12} />}
          {showLow ? 'Hide low-severity' : 'Show low-severity'}
        </button>
        <button
          onClick={() => setShowDismissed(v => !v)}
          className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-gray-500 hover:text-gray-800"
        >
          {showDismissed ? <EyeOff size={12} /> : <Eye size={12} />}
          {showDismissed ? 'Hide dismissed' : 'Show dismissed'}
        </button>
      </div>

      {/* Dismissed artist-flag rows — appears above the body when toggled on. */}
      {showDismissed && (
        <DismissedArtistFlagsSection rows={dismissedRows} busyEntryId={busyEntryId} onRestore={restoreArtistFlag} />
      )}

      {/* Body */}
      {/* visibleCategories, not categories — the headline figures and the rail
          both honour the low-severity toggle, so the body must too or the page
          says "896 need a decision" above a grid that shows more than that. */}
      {activeTab === 'overview' && (
        <Overview categories={visibleCategories} totalFlags={totalFlags} onPick={setTab} />
      )}

      {/* Section header. The category's name and description used to REPLACE
          the page subtitle, so opening a section lost the page's anchor and
          left a long paragraph under a title that no longer described it.
          They belong here, above the rows they describe. */}
      {activeCategory && (
        <div className="border-b border-divider pb-3">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full shrink-0 ${(SEVERITY_STYLE[activeCategory.severity] || SEVERITY_STYLE.medium).dot}`} />
            <h2 className="text-[15px] font-extrabold text-ink">{activeCategory.label}</h2>
            <span className="text-[12px] text-gray-400 tabular-nums">{(activeCategory.count || 0).toLocaleString()}</span>
            <button
              onClick={() => setTab('overview')}
              className="ml-auto text-[11px] font-semibold text-gray-400 hover:text-ink"
            >
              ← All flags
            </button>
          </div>
          {activeCategory.description && (
            <p className="text-[12px] text-gray-400 mt-1.5 max-w-3xl">{activeCategory.description}</p>
          )}
        </div>
      )}

      {activeCategory && activeCategory.count === 0 && (
        <div className="card p-12 text-center">
          <AlertTriangle size={28} className="text-emerald-300 mx-auto mb-3" />
          <p className="text-sm text-gray-500">Nothing flagged in this category.</p>
        </div>
      )}

      {/* Search bar for the active section. Gated on the ORIGINAL count so it
          stays visible when a query matches nothing — otherwise the input
          disappears along with the rows and there's no way to clear it. */}
      {activeCategory && activeCategory.count > 0 && (
        <div className="mb-3">
          <ListSearch
            value={flagQ}
            onChange={setFlagQ}
            placeholder={`Filter ${activeCategory.label.toLowerCase()}…`}
            count={activeShown}
            total={activeTotal}
            width={300}
          />
        </div>
      )}

      {activeCategory && activeCategory.count > 0 && activeShown === 0 && (
        <div className="card p-10 text-center">
          <p className="text-sm text-gray-500">Nothing in this section matches “{flagQ}”.</p>
          <button onClick={() => setFlagQ('')} className="mt-2 text-[12px] font-bold text-boom-600 hover:text-boom-700">
            Clear filter
          </button>
        </div>
      )}

      {activeCategory && activeCategory.count > 0 && activeShown > 0 && (
        <CategoryBody
          cat={filteredCategory}
          isAdmin={isAdmin}
          // Silent refetch after an in-place fix: the row should disappear
          // because the flag stopped being true, not because we hid it.
          onRefresh={() => fetch(false)}
          mergeKeepIds={mergeKeepIds}
          setMergeKeepIds={setMergeKeepIds}
          artistMergeKeepIds={artistMergeKeepIds}
          setArtistMergeKeepIds={setArtistMergeKeepIds}
          mergingKey={mergingKey}
          archivingReleaseId={archivingReleaseId}
          handleArchiveRelease={handleArchiveRelease}
          handleMergeReleases={handleMergeReleases}
          handleMergeArtists={handleMergeArtists}
          handleRenameArtist={handleRenameArtist}
          handleApplyMultiArtist={handleApplyMultiArtist}
          multiArtistBusyKey={multiArtistBusyKey}
          allArtists={allArtists}
          handleMergeVendors={handleMergeVendors}
          vendorMergeKeepNames={vendorMergeKeepNames}
          vendorMergeExcluded={vendorMergeExcluded}
          setVendorMergeExcluded={setVendorMergeExcluded}
          setVendorMergeKeepNames={setVendorMergeKeepNames}
          busyEntryId={busyEntryId}
          onDismissArtistFlag={dismissArtistFlag}
          onApplyArtistFix={applyArtistFix}
          onApplyMissingFix={applyMissingFieldFix}
          onClearArtist={clearArtistField}
          pendingFixes={pendingFixes}
          onUndoFix={undoFix}
          onPreviewInvoice={(entry) => {
            const doc = pickDoc(entry) || DOC_TYPES[0]
            setPreviewFile({
              url: fileUrl(entry, doc.type),
              filename: entry[doc.name] || `${doc.label}-${entry.payee || entry.id}`,
            })
          }}
          onPreviewAll={(invoices) => setPreviewFiles(invoices)}
          onOpenSplit={openSplitModal}
          onToggleGroupDismiss={toggleGroupDismiss}
        />
      )}
        </div>
      </div>

      {/* Single-file preview (one row's invoice clicked) */}
      {previewFile && (
        <FilePreview
          url={previewFile.url}
          filename={previewFile.filename}
          onClose={() => setPreviewFile(null)}
        />
      )}
      {/* Multi-file preview ("View all N invoices" clicked) */}
      {previewFiles && (
        <FilePreview
          files={previewFiles}
          onClose={() => setPreviewFiles(null)}
        />
      )}

      {/* Split modal — divides one ledger entry into N artist-specific
          child rows. Pre-filled from artist_multi_name's parsed suggestion
          when present; user can add/remove/edit rows before saving. */}
      {splitModal && (() => {
        const total = Number(splitModal.row.amount) || 0
        const currency = splitModal.row.currency || 'USD'
        const allocated = splitModal.rows.reduce((s, r) => s + (Number(r.amount) || 0), 0)
        const remaining = +(total - allocated).toFixed(2)
        const fmt = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(n) || 0)
        return (
          <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-6"
            onClick={() => !splitSaving && setSplitModal(null)}>
            <div className="bg-card rounded-2xl shadow-2xl w-full max-w-xl p-6"
              onClick={e => e.stopPropagation()}>
              <h3 className="text-base font-bold text-gray-900 mb-1">Split across multiple artists</h3>
              <p className="text-xs text-gray-500 mb-4">
                {splitModal.row.payee || '—'}
                {total > 0 && <> · invoice total <strong>{fmt(total)}</strong></>}
                . Each row becomes a child entry in the ledger; the original stays as the parent.
              </p>
              <div className="space-y-2">
                {splitModal.rows.map((r, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      type="text"
                      value={r.artist}
                      onChange={e => updateSplitRow(i, 'artist', e.target.value)}
                      placeholder="Artist"
                      disabled={splitSaving}
                      className="flex-1 px-2 py-1.5 text-sm border border-rule rounded-md bg-card focus:outline-none focus:ring-2 focus:ring-boom-400"
                    />
                    <input
                      type="text"
                      value={r.song}
                      onChange={e => updateSplitRow(i, 'song', e.target.value)}
                      placeholder="Song (optional)"
                      disabled={splitSaving}
                      className="w-40 px-2 py-1.5 text-sm border border-rule rounded-md bg-card focus:outline-none focus:ring-2 focus:ring-boom-400"
                    />
                    <input
                      type="number"
                      step="0.01"
                      value={r.amount}
                      onChange={e => updateSplitRow(i, 'amount', e.target.value)}
                      placeholder="0.00"
                      disabled={splitSaving}
                      className="w-28 px-2 py-1.5 text-sm border border-rule rounded-md bg-card focus:outline-none focus:ring-2 focus:ring-boom-400 text-right tabular-nums"
                    />
                    <button
                      onClick={() => removeSplitRow(i)}
                      disabled={splitSaving || splitModal.rows.length <= 2}
                      title={splitModal.rows.length <= 2 ? 'Need at least two rows for a split' : 'Remove this row'}
                      className="p-1.5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
              <button
                onClick={addSplitRow}
                disabled={splitSaving}
                className="mt-2 text-xs font-semibold text-boom-600 hover:text-boom-700 disabled:opacity-40"
              >
                + Add row
              </button>
              {total > 0 && (
                <div className="mt-3 text-xs text-gray-500 flex items-center justify-between">
                  <span>Allocated: <strong className="tabular-nums">{fmt(allocated)}</strong> of <strong className="tabular-nums">{fmt(total)}</strong></span>
                  <span className={Math.abs(remaining) < 0.01 ? 'text-emerald-600' : 'text-amber-600'}>
                    {Math.abs(remaining) < 0.01 ? '✓ Balanced' : `${remaining > 0 ? '+' : ''}${fmt(remaining)} remaining`}
                  </span>
                </div>
              )}
              <div className="flex items-center justify-end gap-2 mt-5">
                <button
                  onClick={() => setSplitModal(null)}
                  disabled={splitSaving}
                  className="px-4 py-2 text-sm font-semibold text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={submitSplit}
                  disabled={splitSaving}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-bold text-white bg-boom-600 hover:bg-boom-700 rounded-lg disabled:opacity-50"
                >
                  <Check size={13} /> {splitSaving ? 'Saving…' : 'Save split'}
                </button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}

// ── Tab button ──────────────────────────────────────────────────────────────
// "Where did this ledger row come from?" — the question the Flags page kept
// making people guess at.
//
// entry_source answers it exactly: `bank_statement` rows were created FROM a
// bank debit (no vendor invoice ever existed, hence no invoice number and no
// file on any of the 1,824 of them), everything else came in as an invoice.
// Without the marker, nine identical "$5.00 · Bank Fees · Paid" rows look like
// sloppy duplicate invoicing rather than a bank charging a fee nine times.
// Every population that legitimately has NO invoice, so an empty document slot
// reads as expected rather than missing. Measured against production: of the 925
// documents in the ledger, every single one belongs to a vendor-submitted entry
// (entry_source NULL). The three sources below hold none at all.
const SOURCE_CHIP = {
  bank_statement:   { label: 'Bank',       hint: 'Booked from a bank statement line — no vendor invoice exists for this row' },
  artist_campaigns: { label: 'Campaign',   hint: 'Created from an artist campaign — campaign spend is recorded without an invoice document' },
  recoupments:      { label: 'Recoupment', hint: 'Created from the recoupments workflow — no vendor invoice exists for this row' },
}

function SourceChip({ source, className = '' }) {
  const meta = SOURCE_CHIP[source]
  if (!meta) return null   // vendor-submitted — an invoice IS expected here
  return (
    <span
      title={meta.hint}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-sky-50 text-sky-700 ring-1 ring-sky-200 shrink-0 ${className}`}
    >
      <Landmark size={9} /> {meta.label}
    </span>
  )
}

// DOC_TYPES / pickDoc / fileUrl moved to utils/entryFiles so the Reports page
// answers "does this row have a file" the same way this one does.

// ── Left rail ───────────────────────────────────────────────────────────────
//
// Replaces the 22-tab horizontal scroller. Grouped by domain because the checks
// span four unrelated things and an undifferentiated list of 22 reads as noise
// no matter how it's styled. Problems sort above completeness inside each
// group, so the money items sit at the top of the rail.
function FlagsNav({ groups, activeTab, onPick, totalFlags }) {
  return (
    <nav data-tour="flags-nav" className="hidden lg:block w-56 shrink-0 sticky top-4 self-start">
      <button
        onClick={() => onPick('overview')}
        className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-[13px] font-bold transition-colors ${
          activeTab === 'overview' ? 'bg-boom-50 text-boom-700' : 'text-ink hover:bg-gray-100'
        }`}
      >
        Overview
        {totalFlags > 0 && <span className="text-[11px] font-semibold text-gray-400 tabular-nums">{totalFlags.toLocaleString()}</span>}
      </button>

      {groups.map(g => (
        <div key={g.name} className="mt-4">
          <p className="px-3 pb-1 text-[10px] font-extrabold uppercase tracking-wider text-gray-400">{g.name}</p>
          {g.cats.map(cat => {
            const sev = SEVERITY_STYLE[cat.severity] || SEVERITY_STYLE.medium
            const active = activeTab === cat.kind
            const empty = !cat.count
            return (
              <button
                key={cat.kind}
                onClick={() => onPick(cat.kind)}
                disabled={empty}
                title={cat.label}
                className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-[12.5px] transition-colors ${
                  active ? 'bg-boom-50 text-boom-700 font-bold'
                    : empty ? 'text-gray-300 cursor-default'
                      : 'text-gray-600 hover:bg-gray-100 hover:text-ink'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${sev.dot} ${empty ? 'opacity-30' : ''}`} />
                <span className="truncate flex-1 text-left">{shortLabel(cat)}</span>
                <span className={`text-[11px] tabular-nums shrink-0 ${empty ? 'text-gray-300' : 'text-gray-400'}`}>{cat.count}</span>
              </button>
            )
          })}
        </div>
      ))}
    </nav>
  )
}

// ── Overview ────────────────────────────────────────────────────────────────
//
// Two sections, because the page covers two different jobs. Things that are
// WRONG get cards and the top of the page. Things merely MISSING get a quiet
// completeness strip — they are bulk data entry, and rendering 473 missing
// ISRCs as an alarming red card next to 76 duplicated invoices is what made
// this page unreadable.
function Overview({ categories, totalFlags, onPick }) {
  const problems = categories.filter(c => isProblem(c) && c.count > 0)
  const incomplete = categories.filter(c => !isProblem(c) && c.count > 0)

  if (totalFlags === 0) {
    return (
      <div data-tour="flags-overview" className="card p-12 text-center">
        <AlertTriangle size={28} className="text-emerald-300 mx-auto mb-3" />
        <p className="text-sm text-gray-500">No flagged data right now.</p>
        <p className="text-xs text-gray-400 mt-1">We check the catalog (duplicate releases / artists, missing genre, UPC, ISRC, Spotify links), the ledger (duplicate vendors and invoices, artist-column problems, rows flagged by hand), and the bank (reconciliation mismatches and transactions flagged in review).</p>
      </div>
    )
  }

  // Problems ordered by domain, Money first — a duplicated invoice costs real
  // money, a duplicate release costs attention.
  const ordered = GROUP_ORDER.flatMap(name =>
    problems.filter(c => classify(c.kind).group === name)
      .sort((a, b) => (b.count || 0) - (a.count || 0)))

  return (
    <div className="space-y-8">
      {ordered.length > 0 && (
        <section>
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="text-[13px] font-extrabold text-ink">Needs a decision</h2>
            <span className="text-[11px] text-gray-400">
              {ordered.reduce((s, c) => s + c.count, 0).toLocaleString()} across {ordered.length} check{ordered.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {ordered.map(cat => {
              const sev = SEVERITY_STYLE[cat.severity] || SEVERITY_STYLE.medium
              return (
                <button
                  key={cat.kind}
                  onClick={() => onPick(cat.kind)}
                  className="card p-4 text-left transition-all hover:border-boom-300 hover:shadow-sm cursor-pointer group"
                >
                  <div className="flex items-center gap-2">
                    {/* The dot already encodes severity. The old HIGH/MEDIUM/LOW
                        chip beside it said the same thing twice and was half the
                        visual noise on this page. */}
                    <span className={`w-2 h-2 rounded-full shrink-0 ${sev.dot}`} />
                    <p className="text-[12px] font-bold text-ink truncate flex-1">{cat.label}</p>
                    <ChevronRight size={14} className="text-gray-300 group-hover:text-boom-500 shrink-0" />
                  </div>
                  <p className="text-2xl font-black text-ink mt-2 tabular-nums">{cat.count.toLocaleString()}</p>
                  <p className="text-[11px] text-gray-400 mt-1 line-clamp-2">{cat.description}</p>
                </button>
              )
            })}
          </div>
        </section>
      )}

      {incomplete.length > 0 && (
        <section>
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="text-[13px] font-extrabold text-ink">Incomplete fields</h2>
            <span className="text-[11px] text-gray-400">
              {incomplete.reduce((s, c) => s + c.count, 0).toLocaleString()} to fill in
            </span>
          </div>
          <div className="card divide-y divide-divider">
            {incomplete.sort((a, b) => b.count - a.count).map(cat => {
              // of_total comes from the server. Without it there is no honest
              // denominator, so show the count alone rather than a bar drawn
              // against a guess.
              const total = Number(cat.of_total) || 0
              const pct = total > 0 ? Math.max(0, Math.min(100, Math.round(((total - cat.count) / total) * 100))) : null
              return (
                <button
                  key={cat.kind}
                  onClick={() => onPick(cat.kind)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-gray-100 transition-colors group"
                >
                  <span className="text-[12.5px] text-ink w-48 shrink-0 truncate">{cat.label}</span>
                  {pct == null ? (
                    <span className="flex-1 text-[11px] text-gray-300">no total available</span>
                  ) : (
                    <span className="flex-1 flex items-center gap-2 min-w-0">
                      <span className="flex-1 h-1.5 rounded-full bg-gray-200 overflow-hidden min-w-0">
                        <span className="block h-full rounded-full bg-emerald-400" style={{ width: `${pct}%` }} />
                      </span>
                      <span className="text-[11px] text-gray-400 tabular-nums w-9 text-right">{pct}%</span>
                    </span>
                  )}
                  <span className="text-[12px] text-gray-500 tabular-nums shrink-0 w-28 text-right">
                    {cat.count.toLocaleString()} missing
                  </span>
                  <ChevronRight size={14} className="text-gray-300 group-hover:text-boom-500 shrink-0" />
                </button>
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}

// ── Body switcher ───────────────────────────────────────────────────────────
function CategoryBody({
  cat, isAdmin,
  mergeKeepIds, setMergeKeepIds, artistMergeKeepIds, setArtistMergeKeepIds,
  mergingKey, archivingReleaseId,
  handleArchiveRelease, handleMergeReleases, handleMergeArtists, handleRenameArtist, handleMergeVendors,
  handleApplyMultiArtist, multiArtistBusyKey, allArtists,
  vendorMergeKeepNames, setVendorMergeKeepNames, vendorMergeExcluded, setVendorMergeExcluded,
  busyEntryId, onDismissArtistFlag, onApplyArtistFix, onApplyMissingFix, onClearArtist, onRefresh,
  pendingFixes, onUndoFix, onPreviewInvoice, onPreviewAll, onOpenSplit,
  // Group-level dismiss/restore. MUST come in as a prop: this is a
  // top-level function, so the same-named helper inside the Duplicates
  // component is not in scope here. It used to be referenced directly,
  // which made every dismiss/restore button below throw a ReferenceError
  // on click.
  onToggleGroupDismiss,
}) {
  // Ledger-row issues (artist column + missing song) share one renderer;
  // the per-kind quick-fix affordance varies based on what `suggestion` looks
  // artist_multi_normalize has its own group-based section — must
  // branch BEFORE the artist_* catch-all below (which expects .items).
  if (cat.kind === 'artist_multi_normalize') {
    return (
      <MultiArtistSection
        groups={cat.groups || []}
        isAdmin={isAdmin}
        allArtists={allArtists}
        onApply={handleApplyMultiArtist}
        busyKey={multiArtistBusyKey}
      />
    )
  }
  // like (missing-song rows have no auto-fix; admin must open the ledger).
  if (cat.kind?.startsWith('artist_') || cat.kind === 'ledger_missing_song' || cat.kind === 'ledger_missing_socials') {
    return (
      <ArtistFlagSection
        cat={cat}
        busyEntryId={busyEntryId}
        onDismiss={onDismissArtistFlag}
        onApplyFix={onApplyArtistFix}
        onApplyMissingFix={onApplyMissingFix}
        onClearArtist={onClearArtist}
        pendingFixes={pendingFixes}
        onUndoFix={onUndoFix}
        onPreviewInvoice={onPreviewInvoice}
        onPreviewAll={onPreviewAll}
        onOpenSplit={onOpenSplit}
      />
    )
  }
  if (cat.kind === 'duplicate_releases') {
    return (
      <DuplicateReleasesSection
        groups={cat.groups || []} isAdmin={isAdmin}
        mergeKeepIds={mergeKeepIds} setMergeKeepIds={setMergeKeepIds}
        mergingKey={mergingKey} archivingReleaseId={archivingReleaseId}
        handleArchive={handleArchiveRelease} handleMerge={handleMergeReleases}
        onDismiss={(gk) => onToggleGroupDismiss('duplicate_releases', gk, true)}
        onRestore={(gk) => onToggleGroupDismiss('duplicate_releases', gk, false)}
      />
    )
  }
  if (cat.kind === 'duplicate_artists') {
    return (
      <DuplicateArtistsSection
        groups={cat.groups || []} isAdmin={isAdmin}
        mergeKeepIds={artistMergeKeepIds} setMergeKeepIds={setArtistMergeKeepIds}
        mergingKey={mergingKey} handleMerge={handleMergeArtists}
        onDismiss={(gk) => onToggleGroupDismiss('duplicate_artists', gk, true)}
        onRestore={(gk) => onToggleGroupDismiss('duplicate_artists', gk, false)}
        onRename={handleRenameArtist}
      />
    )
  }
  if (cat.kind === 'duplicate_vendors') {
    return (
      <DuplicateVendorsSection
        groups={cat.groups || []} isAdmin={isAdmin}
        mergeKeepNames={vendorMergeKeepNames} setMergeKeepNames={setVendorMergeKeepNames}
        excluded={vendorMergeExcluded} setExcluded={setVendorMergeExcluded}
        mergingKey={mergingKey} handleMerge={handleMergeVendors}
        onDismiss={(gk) => onToggleGroupDismiss('duplicate_vendors', gk, true)}
        onRestore={(gk) => onToggleGroupDismiss('duplicate_vendors', gk, false)}
      />
    )
  }
  if (cat.kind === 'duplicate_invoices') {
    return (
      <DuplicateInvoicesSection
        groups={cat.groups || []} isAdmin={isAdmin}
        onDismiss={(gk) => onToggleGroupDismiss('duplicate_invoices', gk, true)}
        onRestore={(gk) => onToggleGroupDismiss('duplicate_invoices', gk, false)}
        onPreviewInvoice={onPreviewInvoice}
      />
    )
  }
  if (cat.kind === 'releases_missing_genre')   return <ReleaseListSection items={cat.items} />
  if (cat.kind === 'releases_missing_upc')     return <ReleaseListSection items={cat.items} />
  if (cat.kind === 'releases_missing_isrc')    return <ReleaseListSection items={cat.items} />
  if (cat.kind === 'releases_missing_spotify') return <ReleaseListSection items={cat.items} />
  if (cat.kind === 'artists_missing_genre')    return <ArtistListSection items={cat.items} />
  if (cat.kind === 'artists_missing_spotify')  return <ArtistListSection items={cat.items} />
  if (cat.kind === 'flagged_expenses')         return <FlaggedExpensesSection items={cat.items} onPreviewInvoice={onPreviewInvoice} />
  if (cat.kind === 'flagged_transactions')     return <FlaggedTransactionsSection items={cat.items} />
  if (cat.kind === 'bank_flags')               return <BankFlagsSection items={cat.items} onRefresh={onRefresh} />
  // Same rows, same one-click actions — it's the same flag shape, just isolated
  // into its own subpage.
  if (cat.kind === 'paid_no_match')            return <BankFlagsSection items={cat.items} onRefresh={onRefresh} />
  if (cat.kind === 'unmatched_bank')           return <UnmatchedBankSection items={cat.items} onRefresh={onRefresh} />
  if (cat.kind === 'duplicate_payments')       return <DuplicatePaymentsSection items={cat.items} onRefresh={onRefresh} />
  return null
}

// ── Section: one payment recorded as two ledger rows ────────────────────────
//
// A table for scanning and a deck for deciding. The table is deliberately
// read-only: 184 pairs is too many to work from a list, and a merge is a
// financial write that deserves the full context of both rows side by side
// rather than a button at the end of a cramped row.
function DuplicatePaymentsSection({ items = [], onRefresh }) {
  const [deck, setDeck] = useState(null)   // { rows, index, merged, rejected }
  const [busy, setBusy] = useState(false)
  // Same shared setting as the statements and Reports decks.
  const [previewOn, togglePreview] = useDeckPreview()

  // Snapshotted at open, like both existing decks. Splicing the array as pairs
  // are resolved would shift every later index and make "{i} of {n}" lie.
  const open = () => setDeck({ rows: items, index: 0, merged: 0, rejected: 0 })
  const close = async () => { setDeck(null); await onRefresh?.() }
  const advance = (patch = {}) => setDeck(d => (d ? { ...d, index: d.index + 1, ...patch } : d))

  const act = async (kind) => {
    if (!deck || busy) return
    const p = deck.rows[deck.index]
    if (!p) return
    setBusy(true)
    try {
      if (kind === 'merge') {
        await api.post('/statements/duplicate-pairs/merge', { orphan_id: p.orphan_id, twin_id: p.twin_id })
        advance({ merged: deck.merged + 1 })
      } else if (kind === 'reject') {
        await api.post('/statements/duplicate-pairs/reject', { orphan_id: p.orphan_id })
        advance({ rejected: deck.rejected + 1 })
      } else {
        advance()
      }
    } catch (err) {
      alert('Failed: ' + (err.response?.data?.error || err.message))
    } finally { setBusy(false) }
  }

  useEffect(() => {
    if (!deck) return
    const h = (e) => {
      if (e.key === 'Escape') { close(); return }
      if (busy) return
      if (e.key === 'Enter') { e.preventDefault(); act('merge') }
      else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); act('reject') }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); act('skip') }
      else if (e.key === 'p' || e.key === 'P') { e.preventDefault(); togglePreview() }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })

  const doc = (has) => (has
    ? <span className="text-emerald-600 font-bold">✓</span>
    : <span className="text-gray-300">✗</span>)

  return (
    <>
      <div className="card">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-divider">
          <span className="text-[12px] text-gray-500">
            {items.length} pair{items.length === 1 ? '' : 's'} to review
          </span>
          <button onClick={open}
            className="inline-flex items-center gap-1.5 bg-ink text-card hover:opacity-85 rounded-lg px-3 py-1.5 text-[12px] font-bold">
            <Copy size={13} /> Review {items.length}
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead className="bg-gray-50/70 text-[11px] uppercase tracking-wider text-gray-400">
              <tr>
                <th className="px-3 py-2 text-left font-bold">Payee</th>
                <th className="px-3 py-2 text-right font-bold">Amount</th>
                <th className="px-3 py-2 text-left font-bold">Keep</th>
                <th className="px-3 py-2 text-left font-bold">Archive</th>
                <th className="px-3 py-2 text-left font-bold">Bank row</th>
              </tr>
            </thead>
            <tbody>
              {items.slice(0, 40).map(p => (
                <tr key={`${p.orphan_id}:${p.twin_id}`} className="border-t border-divider">
                  <td className="px-3 py-1.5 font-semibold text-ink truncate max-w-[220px]">{p.orphan_payee}</td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">{usdRound(p.amount)}</td>
                  <td className="px-3 py-1.5 text-gray-500">
                    #{p.orphan_id}{p.orphan_invoice ? ` · ${p.orphan_invoice}` : ''}
                  </td>
                  <td className="px-3 py-1.5 text-gray-400">
                    #{p.twin_id}{p.twin_source === 'bank_statement' ? ' · from statement' : ''}
                  </td>
                  <td className="px-3 py-1.5 text-gray-400">
                    {p.match_method} · {p.gap_days}d apart
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {items.length > 40 && (
            <p className="px-3 py-2 text-[11.5px] text-gray-400">
              Showing 40 of {items.length} — the deck walks all of them.
            </p>
          )}
        </div>
      </div>

      {deck && (() => {
      const p = deck.rows[deck.index]
      // Which side's document to show. The KEPT row first, not the archived one:
      // it is the row that survives the merge, so its invoice is the document
      // that ends up on the ledger, and it is also the side that usually has one
      // (95 of 102 live pairs, against 71 for the twin — the twin is typically
      // the bank-created row, which has no file by construction).
      //
      // Labelled either way. Showing one row's invoice unlabelled, on a card
      // whose whole job is comparing two rows, would be worse than showing none.
      const side = !p ? null
        : p.orphan_has_invoice ? { id: p.orphan_id, label: `Keep · #${p.orphan_id} invoice` }
        : p.twin_has_invoice ? { id: p.twin_id, label: `Archive · #${p.twin_id} invoice` }
        : null
      return (
        <ReviewDeck
          index={deck.index}
          total={deck.rows.length}
          label={
            <span className="inline-flex items-center gap-2 min-w-0">
              <span className="truncate">One payment, two rows</span>
              <button onClick={togglePreview}
                title={previewOn ? 'Hide the document panel (P)' : 'Show the invoice beside each pair (P)'}
                className="inline-flex items-center gap-1 text-white/60 hover:text-white font-semibold shrink-0">
                <FileText size={12} /> {previewOn ? 'on' : 'off'}
              </button>
            </span>
          }
          // The card is a 620px side-by-side comparison, so it keeps its width
          // rather than being squeezed into the default column.
          cardWidth="lg:w-[620px]"
          aside={previewOn && p ? (
            <InlineFilePreview
              url={side ? fileUrl({ id: side.id }, 'invoice') : null}
              label={side ? side.label : 'No invoice'}
              meta={p.orphan_payee}
              emptyText="Neither row has an invoice file — the bank match and the dates are the only evidence here." />
          ) : null}
          onClose={close}
          done={deck.index >= deck.rows.length}
          doneTitle="Pairs reviewed"
          doneSummary={`${deck.merged} merged, ${deck.rejected} kept as separate invoices.`}
          hint="⏎ merge · N not a duplicate · ← skip · P preview · Esc close"
        >
          {/* A FUNCTION, not a node. On the last card `index` runs one past the
              end and the pair is undefined; an eagerly-evaluated node would
              dereference it and white-page the hub. */}
          {() => {
            return (
              <div className="bg-card rounded-2xl p-6 shadow-2xl w-full lg:w-[620px] max-w-full">
                <div className="flex items-baseline justify-between mb-4">
                  <span className="text-[15px] font-bold text-ink truncate">{p.orphan_payee}</span>
                  <span className="font-mono text-lg font-black text-ink">{usdRound(p.amount)}</span>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl border-2 border-emerald-300 bg-emerald-50/40 p-3">
                    <div className="text-[10px] font-extrabold uppercase tracking-wider text-emerald-700 mb-1.5">
                      Keep · #{p.orphan_id}
                    </div>
                    <dl className="text-[12px] text-gray-600 space-y-0.5">
                      <div>{p.orphan_invoice || <span className="text-gray-400">no invoice number</span>}</div>
                      <div>paid {formatDate(p.orphan_paid)}</div>
                      <div>artist: {p.orphan_artist || <span className="text-gray-400">—</span>}</div>
                      <div>{p.orphan_category || '—'}</div>
                      <div className="pt-1">invoice {doc(p.orphan_has_invoice)} &nbsp; W9 {doc(p.orphan_has_w9)}</div>
                    </dl>
                  </div>
                  <div className="rounded-xl border border-rule bg-gray-50/60 p-3">
                    <div className="text-[10px] font-extrabold uppercase tracking-wider text-gray-400 mb-1.5">
                      Archive · #{p.twin_id}
                    </div>
                    <dl className="text-[12px] text-gray-500 space-y-0.5">
                      <div>{p.twin_invoice || <span className="text-gray-400">no invoice number</span>}</div>
                      <div>{p.twin_source === 'bank_statement'
                        ? 'created from the statement'
                        : <span className="text-amber-700 font-semibold">entered by hand — check before merging</span>}</div>
                      <div>artist: {p.twin_artist || <span className="text-gray-400">—</span>}</div>
                      <div className="text-gray-400">holds the bank match</div>
                      <div className="pt-1">invoice {doc(p.twin_has_invoice)} &nbsp; W9 {doc(p.twin_has_w9)}</div>
                    </dl>
                  </div>
                </div>

                <p className="text-[11.5px] text-gray-500 mt-3">
                  Bank: {String(p.account || '').toUpperCase()} {formatDate(p.txn_date)} · matched{' '}
                  <span className="font-semibold">{p.match_method}</span> · {p.gap_days} day{p.gap_days === 1 ? '' : 's'} from the paid date.
                  {(p.twin_has_invoice && !p.orphan_has_invoice) && ' The archived row’s invoice file is carried over.'}
                </p>

                <div className="flex items-center gap-2 mt-5">
                  <button onClick={() => act('merge')} disabled={busy}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg px-3 py-2 text-[13px] font-bold disabled:opacity-50">
                    {busy ? <Loader size={14} className="animate-spin" /> : <Check size={15} />} Merge
                  </button>
                  <button onClick={() => act('reject')} disabled={busy}
                    className="inline-flex items-center gap-1.5 border border-rule text-gray-600 hover:bg-gray-50 rounded-lg px-3 py-2 text-[13px] font-bold disabled:opacity-50">
                    <X size={15} /> Not a duplicate
                  </button>
                  <button onClick={() => act('skip')} disabled={busy}
                    className="inline-flex items-center gap-1.5 text-gray-400 hover:text-ink rounded-lg px-3 py-2 text-[13px] font-semibold disabled:opacity-50">
                    Skip
                  </button>
                </div>
                <p className="text-[11px] text-gray-400 mt-2 text-center">
                  Merging archives #{p.twin_id} — it stays restorable from Archived Invoices.
                </p>
              </div>
            )
          }}
        </ReviewDeck>
      )
      })()}
    </>
  )
}

// ── Section: ledger rows someone flagged for review ─────────────────────────
// Read-and-jump, not fix-in-place. The flag toggle lives on the row itself
// (FlagButton, which owns the reason popover); duplicating that editor here
// would mean two places that can write flag_reason.
function FlaggedExpensesSection({ items = [], onPreviewInvoice }) {
  if (!items.length) return <p className="text-sm text-gray-400 p-4">Nothing flagged.</p>
  return (
    <div className="card divide-y divide-divider">
      {items.map(r => (
        <div key={r.id} className="flex items-start gap-3 px-4 py-3">
          <div className="w-1.5 h-1.5 rounded-full bg-amber-500 mt-2 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-[13px] font-bold text-gray-900 truncate">{r.payee || '—'}</span>
              <SourceChip source={r.entry_source} />
              <span className="font-mono text-[12px] text-gray-500">
                {Number(r.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })} {r.currency}
              </span>
              {r.payment_status && (
                <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">{r.payment_status}</span>
              )}
            </div>
            <p className="text-[11px] text-gray-400 truncate">
              {[r.artist, r.category, r.invoice_number ? `inv ${r.invoice_number}` : null, formatDate(r.invoice_date)].filter(Boolean).join(' · ')}
            </p>
            {r.flag_reason && <p className="text-[12px] text-amber-700 mt-0.5">“{r.flag_reason}”</p>}
            {r.flagged_by_name && (
              <p className="text-[10px] text-gray-400 mt-0.5">flagged by {r.flagged_by_name}{r.flagged_at ? ` · ${formatDate(r.flagged_at)}` : ''}</p>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0 mt-0.5">
            {pickDoc(r) && onPreviewInvoice && (
              <button
                onClick={() => onPreviewInvoice(r)}
                title={r[pickDoc(r).name] ? `View ${r[pickDoc(r).name]}` : `View ${pickDoc(r).label}`}
                className="p-1.5 rounded text-gray-400 hover:text-blue-600 hover:bg-blue-50"
              >
                <FileText size={13} />
              </button>
            )}
            <Link to={`/bk/ledger?entry=${r.id}`} className="text-[11px] font-bold text-boom-600 hover:text-boom-700 inline-flex items-center gap-1">
              Ledger <ExternalLink size={11} />
            </Link>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Section: bank transactions flagged during a deck run ────────────────────
// The deep-link uses the payee, not the txn id: /bk/statements?q= is the
// existing entry point (Bank Vendors already uses it) and it lands on the
// all-transactions view pre-filtered, which is where the fix actions are.
function FlaggedTransactionsSection({ items = [] }) {
  if (!items.length) return <p className="text-sm text-gray-400 p-4">Nothing flagged in review.</p>
  return (
    <div className="card divide-y divide-divider">
      {items.map(t => (
        <div key={t.id} className="flex items-start gap-3 px-4 py-3">
          <div className="w-1.5 h-1.5 rounded-full bg-amber-500 mt-2 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-[13px] font-bold text-gray-900 truncate">{t.payee_guess || t.description || '—'}</span>
              <span className={`font-mono text-[12px] ${t.direction === 'credit' ? 'text-sky-700' : 'text-gray-500'}`}>
                {t.direction === 'credit' ? '+' : '−'}{Number(t.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })} {t.currency}
              </span>
              {!t.is_booked && (
                <span className="text-[10px] font-bold uppercase tracking-wider text-rose-600">not booked</span>
              )}
            </div>
            <p className="text-[11px] text-gray-400 truncate">
              {[formatDate(t.txn_date), String(t.account || '').toUpperCase(), t.flagged_by ? `flagged by ${t.flagged_by}` : null].filter(Boolean).join(' · ')}
            </p>
          </div>
          <Link to={`/bk/statements?q=${encodeURIComponent(t.payee_guess || '')}`}
            className="text-[11px] font-bold text-boom-600 hover:text-boom-700 shrink-0 mt-1 inline-flex items-center gap-1">
            Statement <ExternalLink size={11} />
          </Link>
        </div>
      ))}
    </div>
  )
}

// ── Section: reconciliation flags from the statements engine ────────────────
// Index only. Each statement flag carries its own one-click fix (mark unpaid,
// remove the duplicate copy, match the debit) and that machinery lives in
// BkStatements — reimplementing it here would fork the fix logic, so each row
// deep-links to the statement pre-filtered to the payee, exactly as the
// Statements Flags subpage does.
// The flag text names four causes — wrong payment date, wrong method, paid from
// an account with no statement, or not actually paid. Three of those are a
// one-field edit, so they are offered HERE rather than as a link to go and
// retype what the flag already knows. The fourth (the payment exists but wasn't
// matched) still needs the statements search, which stays as a link.
function PaidNoMatchFix({ f, onDone }) {
  const e = f.entry || {}
  const [open, setOpen] = useState(false)
  const [date, setDate] = useState((e.payment_date || '').slice(0, 10))
  const [method, setMethod] = useState(e.payment_method || '')
  const [busy, setBusy] = useState(null)
  const [err, setErr] = useState(null)

  const dirty = date !== (e.payment_date || '').slice(0, 10) || method !== (e.payment_method || '')

  const run = async (label, fn) => {
    setBusy(label); setErr(null)
    try { await fn(); await onDone() } catch (ex) {
      setErr(ex.response?.data?.error || ex.message)
      setBusy(null)
    }
  }
  const saveEdit = () => run('save', () => api.put(`/bk/payments/${e.id}`, {
    ...(date !== (e.payment_date || '').slice(0, 10) ? { payment_date: date } : {}),
    ...(method !== (e.payment_method || '') ? { payment_method: method } : {}),
  }))
  const markUnpaid = () => {
    if (!confirm(`Mark ${e.payee || 'this entry'} as Unpaid?\n\nUse this when the bank never shows the payment because it never happened. Reversible from the ledger.`)) return
    run('unpaid', () => api.put(`/bk/payments/${e.id}`, { payment_status: 'Unpaid' }))
  }
  // Acknowledging keeps the row in the books and stops it asking again — the
  // right answer for a real payment from an account we don't upload statements
  // for. Distinct from marking it unpaid, which changes the money.
  const acknowledge = () => run('ack', () => api.post('/statements/flags/ack', { fingerprint: f.fingerprint }))

  if (!e.id) {
    return (
      <Link to={f.q ? `/bk/statements?q=${encodeURIComponent(f.q)}` : '/bk/statements?view=flags'}
        className="text-[11px] font-bold text-boom-600 hover:text-boom-700 shrink-0 mt-1 inline-flex items-center gap-1">
        Fix <ExternalLink size={11} />
      </Link>
    )
  }

  return (
    <div className="shrink-0 mt-0.5">
      <button onClick={() => setOpen(!open)}
        className="text-[11px] font-bold text-boom-600 hover:text-boom-700 inline-flex items-center gap-1">
        Fix {open ? <ChevronRight size={11} className="rotate-90" /> : <ChevronRight size={11} />}
      </button>
      {open && (
        <div className="mt-2 w-[330px] rounded-lg border border-rule bg-gray-50/60 p-2.5 space-y-2">
          <div className="flex items-end gap-1.5">
            <label className="flex-1">
              <span className="block text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-0.5">Paid on</span>
              <input type="date" value={date} onChange={(ev) => setDate(ev.target.value)}
                className="w-full border border-rule rounded px-1.5 py-1 text-[12px] bg-card text-ink" />
            </label>
            <label className="flex-1">
              <span className="block text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-0.5">Method</span>
              <select value={method} onChange={(ev) => setMethod(ev.target.value)}
                className="w-full border border-rule rounded px-1.5 py-1 text-[12px] bg-card text-ink">
                <option value="">—</option>
                {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <button onClick={saveEdit} disabled={!dirty || !!busy}
              title={dirty ? 'Save and re-check against the statements' : 'Change the date or method first'}
              className="border border-rule rounded px-2 py-1 text-[11.5px] font-bold text-gray-600 hover:text-boom-700 hover:border-boom-300 disabled:opacity-40">
              {busy === 'save' ? '…' : 'Save'}
            </button>
          </div>
          {/* Says which statement was checked, so "wrong method" is diagnosable
              rather than a guess. */}
          {e.account && (
            <p className="text-[10.5px] text-gray-400">
              Checked the <strong className="font-semibold text-gray-500">{String(e.account).toUpperCase()}</strong> statement covering {String(e.payment_date || '').slice(0, 10)}.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            <button onClick={markUnpaid} disabled={!!busy}
              title="It never actually left — put it back to Unpaid"
              className="border border-rose-200 text-rose-700 rounded px-2 py-1 text-[11px] font-bold hover:bg-rose-50 disabled:opacity-40">
              {busy === 'unpaid' ? '…' : 'Not actually paid'}
            </button>
            <button onClick={acknowledge} disabled={!!busy}
              title="A real payment from an account with no statement uploaded — keep it paid and stop flagging it"
              className="border border-rule text-gray-600 rounded px-2 py-1 text-[11px] font-bold hover:bg-gray-100 disabled:opacity-40">
              {busy === 'ack' ? '…' : 'Off-statement — stop asking'}
            </button>
            <Link to={`/bk/statements?q=${encodeURIComponent(f.q || e.payee || '')}`}
              title="The payment may be on a statement under a different amount or date"
              className="text-[11px] font-bold text-boom-600 hover:text-boom-700 inline-flex items-center gap-1 ml-auto">
              Find it <ExternalLink size={10} />
            </Link>
          </div>
          {err && <p className="text-[11px] font-semibold text-rose-600">{err}</p>}
        </div>
      )}
    </div>
  )
}

// Bank rows nothing in the ledger accounts for.
//
// Dismiss is a first-class answer here, not a way to hide work: a bank fee, an
// owner transfer or a personal charge is never going to have an invoice, and
// pretending otherwise leaves a backlog that can only grow. So the row offers
// both real outcomes — go book/match it in the deck, or say it doesn't belong —
// and dismissals stay reversible from the same list.
function UnmatchedBankSection({ items = [], onRefresh }) {
  const [busy, setBusy] = useState(null)
  const [sel, setSel] = useState(new Set())
  const [reason, setReason] = useState('')
  const [err, setErr] = useState(null)
  const live = items.filter(r => !r.dismissed)
  const gone = items.filter(r => r.dismissed)

  if (!items.length) return <p className="text-sm text-gray-400 p-4">Every statement item is accounted for.</p>

  const run = async (label, fn) => {
    setBusy(label); setErr(null)
    try { await fn(); setSel(new Set()); setReason(''); await onRefresh() }
    catch (e) { setErr(e.response?.data?.error || e.message) }
    finally { setBusy(null) }
  }
  const dismissOne = (r) => run(`d${r.id}`, () =>
    api.post(`/statements/tx/${r.id}/dismiss`, { reason: reason.trim() || 'not a ledger item' }))
  const restoreOne = (r) => run(`r${r.id}`, () =>
    api.post(`/statements/tx/${r.id}/dismiss`, { undo: true }))
  const dismissSelected = () => {
    if (!sel.size) return
    if (!confirm(`Dismiss ${sel.size} statement item${sel.size === 1 ? '' : 's'}?\n\nThey stay on the statement and stay out of the ledger. Reversible from this list.`)) return
    // Sequential, not Promise.all: each is an admin write and a half-applied
    // bulk is worse than a slow one.
    run('bulk', async () => { for (const id of sel) await api.post(`/statements/tx/${id}/dismiss`, { reason: reason.trim() || 'not a ledger item' }) })
  }
  const toggle = (id) => setSel(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })

  const Row = ({ r }) => (
    <div className={`flex items-center gap-3 px-4 py-2 border-b border-divider text-[12.5px] ${r.dismissed ? 'opacity-60' : ''}`}>
      {!r.dismissed && (
        <input type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} className="shrink-0" />
      )}
      <span className="font-mono text-[11px] text-gray-400 shrink-0 w-[78px]">{formatDate(r.txn_date)}</span>
      <span className={`shrink-0 text-[9px] font-extrabold uppercase tracking-wide rounded px-1 py-px ${r.direction === 'credit' ? 'text-emerald-700 bg-emerald-50' : 'text-gray-500 bg-gray-100'}`}>
        {r.direction === 'credit' ? 'in' : 'out'}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold text-ink truncate">{r.payee_guess || r.description || '—'}</span>
        <span className="block text-[11px] text-gray-400 truncate">
          {[String(r.account || '').toUpperCase(), r.payee_guess ? r.description : null,
            r.dismissed ? `dismissed — ${r.dismissed_reason || 'no reason given'}` : null]
            .filter(Boolean).join(' · ')}
        </span>
      </span>
      <span className="font-mono font-bold shrink-0">
        {usdRound(r.amount_usd ?? r.amount)}
        {r.currency && r.currency !== 'USD' && (
          <span className="text-[10px] text-gray-400 font-normal"> ({r.currency})</span>
        )}
      </span>
      {r.dismissed ? (
        <button onClick={() => restoreOne(r)} disabled={!!busy}
          className="shrink-0 text-[11px] font-bold text-gray-500 hover:text-boom-700 disabled:opacity-40">
          {busy === `r${r.id}` ? '…' : 'Restore'}
        </button>
      ) : (
        <>
          <Link to={`/bk/statements?q=${encodeURIComponent(r.payee_guess || r.description || '')}`}
            title="Open in the review deck to book or match it"
            className="shrink-0 text-[11px] font-bold text-boom-600 hover:text-boom-700 inline-flex items-center gap-1">
            Book <ExternalLink size={10} />
          </Link>
          <button onClick={() => dismissOne(r)} disabled={!!busy}
            title="Not a ledger item — keep it on the statement, out of the books"
            className="shrink-0 text-[11px] font-bold text-gray-400 hover:text-rose-600 disabled:opacity-40">
            {busy === `d${r.id}` ? '…' : 'Dismiss'}
          </button>
        </>
      )}
    </div>
  )

  return (
    <div className="card">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-divider bg-gray-50/60">
        <input type="checkbox" checked={!!live.length && sel.size === live.length}
          onChange={() => setSel(sel.size === live.length ? new Set() : new Set(live.map(r => r.id)))}
          title="Select all shown" className="shrink-0" />
        <span className="text-[12px] font-bold text-ink">{sel.size ? `${sel.size} selected` : `${live.length} shown`}</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (optional) — e.g. bank fee, owner transfer"
          className="flex-1 min-w-[180px] border border-rule rounded-lg px-2 py-1 text-[12px] bg-card text-ink" />
        <button onClick={dismissSelected} disabled={!sel.size || !!busy}
          className="shrink-0 border border-rose-200 text-rose-700 rounded-lg px-2.5 py-1 text-[11.5px] font-bold hover:bg-rose-50 disabled:opacity-40">
          {busy === 'bulk' ? 'Dismissing…' : `Dismiss${sel.size ? ` ${sel.size}` : ''}`}
        </button>
      </div>
      {err && <p className="px-4 py-2 text-[12px] font-semibold text-rose-600">{err}</p>}
      <div>{live.map(r => <Row key={r.id} r={r} />)}</div>
      {gone.length > 0 && (
        <>
          <div className="px-4 py-2 border-b border-divider text-[10px] font-extrabold uppercase tracking-wider text-gray-400">
            Dismissed — {gone.length} shown
          </div>
          <div>{gone.map(r => <Row key={r.id} r={r} />)}</div>
        </>
      )}
    </div>
  )
}

function BankFlagsSection({ items = [], onRefresh }) {
  if (!items.length) return <p className="text-sm text-gray-400 p-4">No reconciliation flags.</p>
  return (
    <div className="card divide-y divide-divider">
      {items.map((f, i) => (
        <div key={f.fingerprint || i} className="flex items-start gap-3 px-4 py-3">
          <div className={`w-1.5 h-1.5 rounded-full mt-2 shrink-0 ${f.severity === 'error' ? 'bg-rose-500' : 'bg-amber-500'}`} />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-bold text-gray-900">{f.title}</p>
            {f.detail && <p className="text-[11px] text-gray-400 mt-0.5">{f.detail}</p>}
          </div>
          {f.type === 'paid-no-match' && onRefresh
            ? <PaidNoMatchFix f={f} onDone={onRefresh} />
            : (
              <Link
                to={f.q ? `/bk/statements?q=${encodeURIComponent(f.q)}` : '/bk/statements?view=flags'}
                className="text-[11px] font-bold text-boom-600 hover:text-boom-700 shrink-0 mt-1 inline-flex items-center gap-1">
                Fix <ExternalLink size={11} />
              </Link>
            )}
        </div>
      ))}
    </div>
  )
}

// ── Section: duplicate releases ─────────────────────────────────────────────
function DuplicateReleasesSection({ groups, isAdmin, mergeKeepIds, setMergeKeepIds, mergingKey, archivingReleaseId, handleArchive, handleMerge, onDismiss, onRestore }) {
  return (
    <div className="space-y-3">
      {!isAdmin && (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
          Merging requires admin access. You can still archive individual rows.
        </div>
      )}
      {groups.map((g, idx) => {
        const targetId = mergeKeepIds[idx]
        const isMerging = mergingKey === `dup_rel:${idx}`
        const isDismissed = !!g.dismissed
        return (
          <div key={g.group_key || idx} className={`card p-4 ${isDismissed ? 'opacity-60 bg-gray-50' : ''}`}>
            <div className="flex items-center gap-1.5 mb-3 flex-wrap">
              <Copy size={12} className="text-rose-500" />
              {(g.reasons || []).map((reason, i) => (
                <span key={i} className="text-[11px] font-semibold text-rose-700 bg-rose-100 px-2 py-0.5 rounded-full">{reason}</span>
              ))}
              {isDismissed && (
                <span className="text-[11px] font-semibold text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">
                  Dismissed
                  {g.dismissed_by_name && ` by ${g.dismissed_by_name}`}
                </span>
              )}
              <span className="ml-auto text-[11px] text-gray-400">
                {isAdmin ? 'Select which to keep, then merge' : 'Archive one to resolve'}
              </span>
              {isAdmin && g.group_key && (
                isDismissed ? (
                  <button
                    onClick={() => onRestore(g.group_key)}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 hover:text-emerald-800 border border-transparent hover:border-emerald-200 rounded-lg px-2 py-1 hover:bg-emerald-50"
                    title="Restore — bring this group back onto the flags page"
                  >
                    Restore
                  </button>
                ) : (
                  <button
                    onClick={() => onDismiss(g.group_key)}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-gray-500 hover:text-rose-700 hover:bg-rose-50 border border-transparent hover:border-rose-200 rounded-lg px-2 py-1"
                    title="Dismiss — hide this group from the flags page"
                  >
                    <X size={14} /> Dismiss
                  </button>
                )
              )}
            </div>
            <div className="space-y-1.5">
              {g.releases.map(r => {
                const busy = archivingReleaseId === r.id || isMerging
                const isTarget = targetId === r.id
                return (
                  <div key={r.id} className={`flex items-center gap-3 px-3 py-2 rounded-lg border transition-colors ${
                    isTarget ? 'bg-emerald-50 border-emerald-200' : 'bg-gray-50 border-divider'
                  }`}>
                    {isAdmin && (
                      <label className="flex items-center gap-2 flex-shrink-0 cursor-pointer">
                        <input type="radio" name={`merge-keep-${idx}`} checked={isTarget}
                          onChange={() => setMergeKeepIds(prev => ({ ...prev, [idx]: r.id }))}
                          disabled={busy} className="text-emerald-600 cursor-pointer" />
                        <span className={`text-[10px] font-semibold uppercase tracking-wider ${isTarget ? 'text-emerald-700' : 'text-gray-400'}`}>
                          {isTarget ? 'Keep' : 'Keep?'}
                        </span>
                      </label>
                    )}
                    {r.cover_art_url && r.cover_art_url !== 'not_found' ? (
                      <img src={r.cover_art_url} alt="" className="w-10 h-10 rounded object-cover flex-shrink-0" />
                    ) : <div className="w-10 h-10 rounded bg-gray-100 flex-shrink-0" />}
                    <Link to={`/releases/${r.id}`} className="flex-1 min-w-0 hover:opacity-80">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-gray-900 truncate">{r.project_name || '—'}</span>
                        <span className="text-xs text-gray-500">{r.artist_name}</span>
                      </div>
                      <div className="flex items-center gap-2.5 mt-0.5 flex-wrap">
                        {r.release_date && <span className="text-[11px] text-gray-400">{formatDate(r.release_date)}</span>}
                        {r.upc && <span className="text-[10px] text-gray-400 font-mono">UPC {r.upc}</span>}
                        {r.isrc && <span className="text-[10px] text-gray-400 font-mono">ISRC {r.isrc}</span>}
                        {r.spotify_uri && <span className="text-[10px] text-gray-400 font-mono truncate max-w-[260px]">{r.spotify_uri}</span>}
                      </div>
                    </Link>
                    <button onClick={() => !busy && handleArchive(r.id)} disabled={busy}
                      title="Archive this release"
                      className="p-1.5 rounded text-gray-300 hover:text-amber-500 hover:bg-amber-50 disabled:opacity-40 flex-shrink-0">
                      <Archive size={13} />
                    </button>
                  </div>
                )
              })}
            </div>
            {isAdmin && (
              <div className="flex items-center justify-end mt-3">
                <button onClick={() => handleMerge(idx, g)} disabled={!targetId || isMerging}
                  className="text-xs font-semibold px-3.5 py-2 rounded-lg bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-40">
                  {isMerging ? 'Merging…' : targetId ? `Merge ${g.releases.length - 1} into selected` : 'Pick one to keep'}
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Section: duplicate artists ──────────────────────────────────────────────
function DuplicateArtistsSection({ groups, isAdmin, mergeKeepIds, setMergeKeepIds, mergingKey, handleMerge, onDismiss, onRestore, onRename }) {
  // Only one row across the whole section is editable at a time. Keyed by
  // artist id, storing the draft string as the user types. `null` = no
  // active edit.
  const [editingId, setEditingId] = useState(null)
  const [draftName, setDraftName] = useState('')
  const [savingRename, setSavingRename] = useState(false)
  const [renameError, setRenameError] = useState(null)
  const startEdit = (a) => {
    setEditingId(a.id); setDraftName(a.name || ''); setRenameError(null)
  }
  const cancelEdit = () => { setEditingId(null); setDraftName(''); setRenameError(null) }
  const commitEdit = async (a) => {
    const next = draftName.trim()
    if (!next || next === a.name) { cancelEdit(); return }
    setSavingRename(true); setRenameError(null)
    const result = await onRename?.(a.id, next)
    setSavingRename(false)
    if (result?.ok) {
      cancelEdit()
    } else {
      setRenameError(result?.error || 'Rename failed')
    }
  }
  return (
    <div className="space-y-3">
      {!isAdmin && (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
          Merging requires admin access.
        </div>
      )}
      {groups.map((group, idx) => {
        // Server now wraps the array in { group_key, artists, dismissed? }.
        // Fall back to bare-array shape for forward-safety in case a
        // cached client receives the old shape during deploy.
        const artists = Array.isArray(group) ? group : (group.artists || [])
        const groupKey = group.group_key
        const isDismissed = !!group.dismissed
        const targetId = mergeKeepIds[idx] ?? artists[0]?.id
        const isMerging = mergingKey === `dup_art:${idx}`
        return (
          <div key={groupKey || idx} className={`card p-4 ${isDismissed ? 'opacity-60 bg-gray-50' : ''}`}>
            <div className="flex items-center gap-1.5 mb-3 flex-wrap">
              <Copy size={12} className="text-rose-500" />
              <span className="text-[11px] font-semibold text-rose-700 bg-rose-100 px-2 py-0.5 rounded-full">Same / similar name</span>
              {isDismissed && (
                <span className="text-[11px] font-semibold text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">
                  Dismissed
                  {group.dismissed_by_name && ` by ${group.dismissed_by_name}`}
                </span>
              )}
              <span className="ml-auto text-[11px] text-gray-400">
                {isAdmin ? 'Pick the canonical record' : 'Admin-only merge'}
              </span>
              {isAdmin && groupKey && (
                isDismissed ? (
                  <button
                    onClick={() => onRestore(groupKey)}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 hover:text-emerald-800 border border-transparent hover:border-emerald-200 rounded-lg px-2 py-1 hover:bg-emerald-50"
                    title="Restore — bring this group back onto the flags page"
                  >
                    Restore
                  </button>
                ) : (
                  <button
                    onClick={() => onDismiss(groupKey)}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-gray-500 hover:text-rose-700 hover:bg-rose-50 border border-transparent hover:border-rose-200 rounded-lg px-2 py-1"
                    title="Dismiss — hide this group from the flags page"
                  >
                    <X size={14} /> Dismiss
                  </button>
                )
              )}
            </div>
            <div className="space-y-1.5">
              {artists.map(a => {
                const isTarget = targetId === a.id
                const isEditing = editingId === a.id
                return (
                  <div key={a.id} className={`flex items-center gap-3 px-3 py-2 rounded-lg border group ${
                    isTarget ? 'bg-emerald-50 border-emerald-200' : 'bg-gray-50 border-divider'
                  }`}>
                    {isAdmin && !isDismissed && (
                      <label className="flex items-center gap-2 flex-shrink-0 cursor-pointer">
                        <input type="radio" name={`art-keep-${idx}`} checked={isTarget}
                          onChange={() => setMergeKeepIds(prev => ({ ...prev, [idx]: a.id }))}
                          disabled={isMerging || isEditing} className="text-emerald-600 cursor-pointer" />
                        <span className={`text-[10px] font-semibold uppercase tracking-wider ${isTarget ? 'text-emerald-700' : 'text-gray-400'}`}>
                          {isTarget ? 'Keep' : 'Keep?'}
                        </span>
                      </label>
                    )}
                    {isEditing ? (
                      // Inline edit mode — input takes the space the artist
                      // name normally occupies; Save/Cancel trail on the right.
                      // Autofocus so the user can start typing immediately;
                      // Enter saves, Escape cancels.
                      <div className="flex-1 min-w-0 flex items-center gap-2">
                        <input
                          type="text"
                          autoFocus
                          value={draftName}
                          onChange={e => setDraftName(e.target.value.slice(0, 200))}
                          onKeyDown={e => {
                            if (e.key === 'Enter') { e.preventDefault(); commitEdit(a) }
                            else if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
                          }}
                          disabled={savingRename}
                          className="flex-1 text-sm font-semibold text-gray-900 bg-white border border-boom-300 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-boom-400"
                          placeholder="Artist name"
                        />
                        <button
                          onClick={() => commitEdit(a)}
                          disabled={savingRename || !draftName.trim() || draftName.trim() === a.name}
                          title="Save (Enter)"
                          className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40"
                        >
                          {savingRename ? <Loader size={12} className="animate-spin" /> : <Check size={12} />}
                          Save
                        </button>
                        <button
                          onClick={cancelEdit}
                          disabled={savingRename}
                          title="Cancel (Esc)"
                          className="text-xs font-semibold text-gray-500 hover:text-gray-700 px-2 py-1 rounded hover:bg-gray-100"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <>
                        <Link to={`/artists/${a.id}`} className="flex-1 min-w-0 hover:opacity-80">
                          <div className="text-sm font-semibold text-gray-900 truncate">{a.name}</div>
                          <div className="text-[11px] text-gray-400 mt-0.5">
                            {a.total_releases || 0} release{a.total_releases === 1 ? '' : 's'}
                            {a.contract_count > 0 && ` · ${a.contract_count} contract${a.contract_count === 1 ? '' : 's'}`}
                          </div>
                        </Link>
                        {isAdmin && !isDismissed && (
                          <button
                            onClick={() => startEdit(a)}
                            title="Rename this artist — cascades to expenses / deals / income rows referring to the old name"
                            className="text-gray-300 hover:text-boom-600 p-1 rounded hover:bg-boom-50 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                          >
                            <Pencil size={13} />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )
              })}
              {renameError && editingId != null && (
                <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1">
                  {renameError}
                </div>
              )}
            </div>
            {isAdmin && !isDismissed && (
              <div className="flex items-center justify-end mt-3">
                <button onClick={() => handleMerge(idx, artists)} disabled={!targetId || isMerging}
                  className="text-xs font-semibold px-3.5 py-2 rounded-lg bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-40">
                  {isMerging ? 'Merging…' : `Merge ${artists.length - 1} into selected`}
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Section: duplicate vendors ──────────────────────────────────────────────
// Mirrors DuplicateArtistsSection visually but keys the merge target by payee
// string (vendors aren't first-class rows). Each row links to the vendor's
// /bk/vendors/:payee detail page for full context before committing.
// ── Section: multi-artist normalization ─────────────────────────────────────
// Renders one card per distinct multi-artist expenses.artist string.
// Each card shows the string + row count + total spend, the parsed
// sub-artist candidates as radios, and a typeahead for picking an
// artist that isn't in the parsed set. Apply calls the server, which
// bulk-renames the string across expenses / deals / artist_income and
// registers a permanent mapping so future rows auto-collapse.
function MultiArtistSection({ groups, isAdmin, allArtists, onApply, busyKey }) {
  return (
    <div className="space-y-3">
      {!isAdmin && (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
          Applying a normalization requires admin access.
        </div>
      )}
      {groups.length === 0 && (
        <div className="card p-8 text-center">
          <p className="text-sm text-gray-400">No multi-artist rows on file — nothing to normalize.</p>
        </div>
      )}
      {groups.map(g => (
        <MultiArtistCard
          key={g.source_key}
          group={g}
          isAdmin={isAdmin}
          allArtists={allArtists}
          busy={busyKey === g.source_key}
          onApply={onApply}
        />
      ))}
    </div>
  )
}

function MultiArtistCard({ group, isAdmin, allArtists, busy, onApply }) {
  // Pick the first candidate by default; user can flip or type another.
  const [pick, setPick] = useState(group.candidates?.[0] || '')
  const [customQuery, setCustomQuery] = useState('')
  const [pickedArtistId, setPickedArtistId] = useState(null)
  const [error, setError] = useState(null)
  // Typeahead filter — case-insensitive substring. Cap at 8 results
  // to keep the dropdown short; the user can refine the query if the
  // artist they want isn't in the visible set.
  const filtered = useMemo(() => {
    if (!customQuery.trim()) return []
    const q = customQuery.trim().toLowerCase()
    return (allArtists || [])
      .filter(a => a.name.toLowerCase().includes(q))
      .slice(0, 8)
  }, [customQuery, allArtists])
  const currentPick = customQuery.trim() || pick
  const fmtUsd = (n) => new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(Math.round(Number(n) || 0))
  const doApply = async () => {
    setError(null)
    if (!currentPick) { setError('Pick a base artist first'); return }
    const result = await onApply({
      source: group.source_display || group.source_key,
      base: currentPick,
      base_artist_id: pickedArtistId,
    })
    if (!result?.ok) setError(result?.error || 'Apply failed')
  }
  return (
    <div className="card p-4">
      <div className="flex items-center gap-1.5 mb-3 flex-wrap">
        <Copy size={12} className="text-indigo-500" />
        <span className="text-[11px] font-semibold text-indigo-700 bg-indigo-100 px-2 py-0.5 rounded-full">Multi-artist string</span>
        <span className="ml-auto text-[11px] text-gray-400">
          {group.row_count} row{group.row_count === 1 ? '' : 's'} · {fmtUsd(group.total_amount)}
        </span>
      </div>
      <div className="mb-3">
        <div className="text-[10px] uppercase tracking-wide font-bold text-gray-500 mb-1">Current artist string</div>
        <div className="text-sm font-semibold text-gray-900 bg-gray-50 border border-rule rounded px-3 py-2 truncate" title={group.source_display}>
          {group.source_display}
        </div>
      </div>
      <div className="mb-3">
        <div className="text-[10px] uppercase tracking-wide font-bold text-gray-500 mb-1.5">Base artist</div>
        {group.candidates?.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {group.candidates.map(c => (
              <label
                key={c}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold border cursor-pointer transition-colors ${
                  !customQuery.trim() && pick === c
                    ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
                    : 'bg-white border-rule text-gray-700 hover:bg-gray-50'
                }`}
              >
                <input
                  type="radio"
                  name={`base-${group.source_key}`}
                  className="sr-only"
                  checked={!customQuery.trim() && pick === c}
                  onChange={() => { setPick(c); setCustomQuery(''); setPickedArtistId(null) }}
                  disabled={busy || !isAdmin}
                />
                {c}
              </label>
            ))}
          </div>
        )}
        <div className="relative">
          <input
            type="text"
            value={customQuery}
            onChange={e => { setCustomQuery(e.target.value); setPickedArtistId(null) }}
            placeholder="Or search all artists…"
            disabled={busy || !isAdmin}
            className="w-full text-xs rounded-lg bg-card border border-rule px-3 py-2 focus:outline-none focus:border-boom-400"
          />
          {filtered.length > 0 && (
            <div className="absolute left-0 right-0 top-full mt-1 z-10 bg-white border border-rule rounded-lg shadow-md max-h-56 overflow-y-auto">
              {filtered.map(a => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => { setCustomQuery(a.name); setPick(a.name); setPickedArtistId(a.id) }}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50"
                >
                  {a.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {error && (
        <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1 mb-2">
          {error}
        </div>
      )}
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-gray-500">
          Will rename <span className="font-bold">{group.row_count}</span> row
          {group.row_count === 1 ? '' : 's'} to
          <span className="font-bold text-gray-800"> {currentPick || '—'}</span>
          {' '}and remember the mapping.
        </div>
        <button
          onClick={doApply}
          disabled={busy || !isAdmin || !currentPick}
          className="text-xs font-semibold px-3.5 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40"
        >
          {busy ? 'Applying…' : 'Apply'}
        </button>
      </div>
    </div>
  )
}

function DuplicateVendorsSection({ groups, isAdmin, mergeKeepNames, setMergeKeepNames, excluded, setExcluded, mergingKey, handleMerge, onDismiss, onRestore }) {
  const fmtDate = (s) => {
    if (!s) return null
    const d = new Date(s); if (isNaN(d.getTime())) return null
    return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
  }
  return (
    <div className="space-y-3">
      {!isAdmin && (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
          Merging requires admin access.
        </div>
      )}
      {groups.map((group, idx) => {
        // Server now wraps as { group_key, vendors, dismissed? }. Fall
        // through to bare-array shape during the deploy window.
        const vendors = Array.isArray(group) ? group : (group.vendors || [])
        const groupKey = group.group_key
        const isDismissed = !!group.dismissed
        const targetName = mergeKeepNames[idx] ?? vendors[0]?.payee
        const isMerging = mergingKey === `dup_vend:${idx}`
        const excludedNames = new Set((excluded && excluded[idx]) || [])
        const toMerge = vendors.filter(v => v.payee !== targetName && !excludedNames.has(v.payee))
        return (
          <div key={groupKey || idx} className={`card p-4 ${isDismissed ? 'opacity-60 bg-gray-50' : ''}`}>
            <div className="flex items-center gap-1.5 mb-3 flex-wrap">
              <Copy size={12} className="text-rose-500" />
              <span className="text-[11px] font-semibold text-rose-700 bg-rose-100 px-2 py-0.5 rounded-full">Same / similar name</span>
              {isDismissed && (
                <span className="text-[11px] font-semibold text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">
                  Dismissed
                  {group.dismissed_by_name && ` by ${group.dismissed_by_name}`}
                </span>
              )}
              <span className="ml-auto text-[11px] text-gray-400">
                {isAdmin ? 'Pick the canonical name' : 'Admin-only merge'}
              </span>
              {isAdmin && groupKey && (
                isDismissed ? (
                  <button
                    onClick={() => onRestore(groupKey)}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 hover:text-emerald-800 border border-transparent hover:border-emerald-200 rounded-lg px-2 py-1 hover:bg-emerald-50"
                    title="Restore — bring this group back onto the flags page"
                  >
                    Restore
                  </button>
                ) : (
                  <button
                    onClick={() => onDismiss(groupKey)}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-gray-500 hover:text-rose-700 hover:bg-rose-50 border border-transparent hover:border-rose-200 rounded-lg px-2 py-1"
                    title="Dismiss — hide this group from the flags page (e.g. two real vendors that happen to share a similar name)"
                  >
                    <X size={14} /> Dismiss
                  </button>
                )
              )}
            </div>
            <div className="space-y-1.5">
              {vendors.map(v => {
                const isTarget = targetName === v.payee
                const last = fmtDate(v.last_invoice)
                const isOut = excludedNames.has(v.payee)
                return (
                  <div key={v.payee} className={`flex items-center gap-3 px-3 py-2 rounded-lg border ${
                    isTarget ? 'bg-emerald-50 border-emerald-200'
                      : isOut ? 'bg-card border-divider opacity-60'
                        : 'bg-gray-50 border-divider'
                  }`}>
                    {isAdmin && !isDismissed && (
                      <div className="flex items-center gap-2.5 flex-shrink-0">
                        {/* Radio picks the name everything else folds into.
                            "Keep?" on every other row read as a question with no
                            answer — the real second choice is per row: merge this
                            one, or leave it alone. */}
                        <label className="flex items-center gap-1.5 cursor-pointer" title={`Keep "${v.payee}" as the canonical name`}>
                          <input
                            type="radio"
                            name={`vend-keep-${idx}`}
                            checked={isTarget}
                            onChange={() => setMergeKeepNames(prev => ({ ...prev, [idx]: v.payee }))}
                            disabled={isMerging}
                            className="text-emerald-600 cursor-pointer"
                          />
                          <span className={`text-[10px] font-semibold uppercase tracking-wider w-9 ${isTarget ? 'text-emerald-700' : 'text-gray-300'}`}>
                            {isTarget ? 'Keep' : ''}
                          </span>
                        </label>
                        {/* Fuzzy matching drags real third parties into a group.
                            Unticking leaves that vendor completely untouched. */}
                        {!isTarget && (
                          <label className="flex items-center gap-1.5 cursor-pointer" title={isOut ? 'Left alone — not merged' : `Merge "${v.payee}" into the kept name`}>
                            <input
                              type="checkbox"
                              checked={!isOut}
                              onChange={() => setExcluded(prev => {
                                const cur = new Set(prev[idx] || [])
                                if (cur.has(v.payee)) cur.delete(v.payee); else cur.add(v.payee)
                                return { ...prev, [idx]: [...cur] }
                              })}
                              disabled={isMerging}
                              className="text-rose-600 cursor-pointer"
                            />
                            <span className={`text-[10px] font-semibold uppercase tracking-wider ${isOut ? 'text-gray-400' : 'text-rose-600'}`}>
                              {isOut ? 'Leave' : 'Merge'}
                            </span>
                          </label>
                        )}
                      </div>
                    )}
                    <Link to={`/bk/vendors/${encodeURIComponent(v.payee)}`} className="flex-1 min-w-0 hover:opacity-80">
                      <div className="text-sm font-semibold text-gray-900 truncate">{v.payee}</div>
                      <div className="text-[11px] text-gray-400 mt-0.5 flex items-center gap-2 flex-wrap">
                        <span>{v.invoice_count || 0} invoice{v.invoice_count === 1 ? '' : 's'}</span>
                        {v.has_w9
                          ? <span className="text-emerald-600 font-semibold">· W9 on file</span>
                          : <span className="text-amber-600 font-semibold">· No W9</span>}
                        {last && <span>· last {last}</span>}
                      </div>
                    </Link>
                  </div>
                )
              })}
            </div>
            {isAdmin && !isDismissed && (
              <div className="flex items-center justify-end mt-3">
                <button
                  onClick={() => handleMerge(idx, vendors)}
                  disabled={!targetName || isMerging || !toMerge.length}
                  title={toMerge.length ? `Rename ${toMerge.map(v => v.payee).join(', ')} to "${targetName}"` : 'Nothing selected to merge'}
                  className="text-xs font-semibold px-3.5 py-2 rounded-lg bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-40"
                >
                  {isMerging ? 'Merging…'
                    : !toMerge.length ? 'Nothing selected'
                      : `Merge ${toMerge.length} into ${targetName}`}
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Section: duplicate invoices ─────────────────────────────────────────────
// Each "entry" in the group is a ledger row — not a vendor or release — so the
// section mirrors the vendor/artist card chrome but renders one row per entry.
// No merge button: ledger rows don't have a sensible "merge" semantic (you
// just delete the extra one from the ledger). We surface a preview + ledger
// link per row, plus group-level dismiss / restore.
function DuplicateInvoicesSection({ groups, isAdmin, onDismiss, onRestore, onPreviewInvoice }) {
  const fmtMoney = (amount, currency) => {
    const n = Number(amount); if (!Number.isFinite(n)) return '—'
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: (currency || 'USD').toUpperCase() }).format(n)
    } catch { return `${(currency || 'USD').toUpperCase()} ${n.toFixed(2)}` }
  }
  // Severity → chip tint. Tier 1 ≈ high (almost-certain dupe), Tier 2b ≈
  // medium (blank-invoice cluster), Tier 3 ≈ low (cross-vendor coincidence).
  const REASON_TINT = {
    'Same vendor + invoice # + amount':            'text-rose-700 bg-rose-100',
    'Same vendor + invoice # (amount mismatch)':   'text-rose-700 bg-rose-100',
    'Same vendor + amount + date (no invoice #)':  'text-amber-700 bg-amber-100',
    'Same invoice # under different vendors':      'text-blue-700 bg-blue-100',
  }
  return (
    <div className="space-y-3">
      {groups.map((g, idx) => {
        const isDismissed = !!g.dismissed
        const groupKey = g.group_key
        return (
          <div key={groupKey || idx} className={`card p-4 ${isDismissed ? 'opacity-60 bg-gray-50' : ''}`}>
            <div className="flex items-center gap-1.5 mb-3 flex-wrap">
              <Copy size={12} className="text-rose-500" />
              {(g.reasons || []).map((reason, i) => (
                <span key={i} className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${REASON_TINT[reason] || 'text-rose-700 bg-rose-100'}`}>
                  {reason}
                </span>
              ))}
              {isDismissed && (
                <span className="text-[11px] font-semibold text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">
                  Dismissed{g.dismissed_by_name && ` by ${g.dismissed_by_name}`}
                </span>
              )}
              <span className="ml-auto text-[11px] text-gray-400">
                Open the wrong one in the ledger and delete it, or dismiss the group if these are intentional.
              </span>
              {isAdmin && groupKey && (
                isDismissed ? (
                  <button
                    onClick={() => onRestore(groupKey)}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 hover:text-emerald-800 border border-transparent hover:border-emerald-200 rounded-lg px-2 py-1 hover:bg-emerald-50"
                    title="Restore — bring this group back onto the flags page"
                  >
                    Restore
                  </button>
                ) : (
                  <button
                    onClick={() => onDismiss(groupKey)}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-gray-500 hover:text-rose-700 hover:bg-rose-50 border border-transparent hover:border-rose-200 rounded-lg px-2 py-1"
                    title="Dismiss — hide this group (e.g. a recurring monthly invoice that legitimately shares vendor + amount)"
                  >
                    <X size={14} /> Dismiss
                  </button>
                )
              )}
            </div>
            <div className="space-y-1.5">
              {(g.entries || []).map(e => {
                const isPaid = String(e.payment_status || '').toLowerCase() === 'paid'
                return (
                  <div key={e.id} className="flex items-center gap-3 px-3 py-2 rounded-lg border bg-gray-50 border-divider">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-gray-900 truncate">{e.payee || '—'}</span>
                        {e.invoice_number && (
                          <span className="text-[11px] text-gray-500 font-mono bg-gray-100 px-1.5 py-0.5 rounded">
                            #{e.invoice_number}
                          </span>
                        )}
                        <span className="text-[11px] font-semibold tabular-nums text-gray-700">
                          {fmtMoney(e.amount, e.currency)}
                        </span>
                        {isPaid
                          ? <span className="text-[10px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">Paid</span>
                          : <span className="text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">Unpaid</span>}
                        {e.status === 'pending' && (
                          <span className="text-[10px] font-semibold text-blue-700 bg-blue-50 border border-blue-200 px-1.5 py-0.5 rounded">Pending review</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2.5 mt-0.5 flex-wrap text-[11px] text-gray-400">
                        {e.invoice_date && <span>{formatDate(e.invoice_date)}</span>}
                        {e.artist && <span>· {e.artist}</span>}
                        {e.song && <span>· {e.song}</span>}
                        {e.category && <span>· {e.category}</span>}
                      </div>
                    </div>
                    {pickDoc(e) && (
                      <button
                        onClick={() => onPreviewInvoice(e)}
                        title={`Preview ${pickDoc(e).label}`}
                        className="p-1.5 rounded text-gray-400 hover:text-boom-600 hover:bg-boom-50"
                      >
                        <FileText size={13} />
                      </button>
                    )}
                    <Link
                      to={`/bk/ledger?focus=${e.id}`}
                      title="Open in ledger"
                      className="p-1.5 rounded text-gray-400 hover:text-boom-600 hover:bg-boom-50"
                    >
                      <ExternalLink size={13} />
                    </Link>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Section: flat list of releases ──────────────────────────────────────────
function ReleaseListSection({ items }) {
  return (
    <div className="card p-2 space-y-1">
      {items.map(r => (
        <Link key={r.id} to={`/releases/${r.id}`}
          className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-boom-50/30 transition-colors">
          <FileText size={14} className="text-gray-300 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-gray-900 truncate">{r.project_name || '—'}</div>
            <div className="text-[11px] text-gray-400 mt-0.5 flex items-center gap-2 flex-wrap">
              <span>{r.artist_name}</span>
              {r.release_date && <span>· {formatDate(r.release_date)}</span>}
              {r.release_type && <span>· {r.release_type}</span>}
              {r.missing && <span className="text-amber-700 font-semibold">· no {r.missing}</span>}
            </div>
          </div>
          <span className="text-xs text-gray-400 hidden sm:block">Open release →</span>
        </Link>
      ))}
    </div>
  )
}

// ── Section: artists missing genre ──────────────────────────────────────────
function ArtistListSection({ items }) {
  return (
    <div className="card p-2 space-y-1">
      {items.map(a => (
        <Link key={a.id} to={`/artists/${a.id}`}
          className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-boom-50/30 transition-colors">
          <Tag size={14} className="text-gray-300 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-gray-900 truncate">{a.name}</div>
            <div className="text-[11px] text-gray-400 mt-0.5">
              {a.total_releases || 0} release{a.total_releases === 1 ? '' : 's'} on file
            </div>
          </div>
          <span className="text-xs text-gray-400 hidden sm:block">Open artist →</span>
        </Link>
      ))}
    </div>
  )
}

// ── Section: artist-column flags (likely typo, unknown, multi-name, missing,
//    song mismatch, variants). One renderer, per-kind quick action. ────────
function ArtistFlagSection({ cat, busyEntryId, onDismiss, onApplyFix, onApplyMissingFix, onClearArtist, pendingFixes = {}, onUndoFix, onPreviewInvoice, onPreviewAll, onOpenSplit }) {
  const kind = cat.kind
  const items = cat.items || []
  // Missing-field rows render an inline input the user can type into and
  // submit, applying the fix without leaving the page.
  // Every artist-flag row now renders an inline editor + Save button so the
  // user can fix the artist (or song, for ledger_missing_song) without
  // leaving the page. Pre-fill behavior varies by kind — see inlineDefault
  // computed per-row in the map below.
  //
  // ledger_missing_socials is the exception: social_handles is a JSONB array
  // of {platform, handle} pairs, not a single string, so there's no useful
  // inline editor. Those rows surface the dismiss + ledger-link affordances
  // only and route the user to the bookkeeping form to fill the field in.
  const isInlineEditable = kind !== 'ledger_missing_socials'
  const isMissingField = isInlineEditable // legacy var kept for the form gate below
  // Build the multi-file list for the "View all" button — every row in
  // the tab that has an invoice on file (or inherits one from its split
  // parent via file_entry_id). The FilePreview overlay handles cycling
  // between them with arrow keys.
  const invoiceFiles = (items || [])
    .map(r => ({ r, doc: pickDoc(r) }))
    .filter(({ doc }) => doc)
    .map(({ r, doc }) => ({
      url: `/api/bk/entries/${r.file_entry_id || r.id}/file/${doc.type}?token=${localStorage.getItem('token')}`,
      filename: r[doc.name] || `${doc.label}-${r.payee || r.id}${r.artist ? `-${r.artist}` : ''}`,
    }))
  return (
    <div className="space-y-2">
      {invoiceFiles.length > 1 && onPreviewAll && (
        <div className="flex justify-end -mt-1 mb-1">
          <button
            onClick={() => onPreviewAll(invoiceFiles)}
            className="text-xs font-semibold inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-boom-700 bg-boom-50 hover:bg-boom-100 border border-boom-200"
            title={`Cycle through every invoice on file in this tab (${invoiceFiles.length})`}
          >
            <FileText size={12} /> View all {invoiceFiles.length} invoices
          </button>
        </div>
      )}
      {items.map(row => {
        const busy = busyEntryId === row.id
        const sug = row.suggestion
        // Pending-fix state: row stays visible but dimmed + line-through
        // for PENDING_MS so the user can hit Undo. After the timer fires,
        // stripFlag() (in the parent) removes the row from the list.
        const pending = pendingFixes[`${row.id}:${kind}`]
        // Pre-fill the inline editor based on what the server suggested:
        //   • likely_typo / variants / song_mismatch — server suggests a
        //     single replacement; pre-fill with it so the user can hit Save
        //     to accept, or edit then Save.
        //   • unknown / multi_name — no single-string suggestion; pre-fill
        //     with the current (off-roster / multi-name) artist string so
        //     the user edits in place.
        //   • missing_* — leave blank.
        const inlineDefault =
          kind === 'ledger_missing_song'                ? '' :
          kind === 'artist_missing'                      ? '' :
          (!Array.isArray(sug) && sug?.artist_name)      ? sug.artist_name :
          (row.artist || '')
        return (
          <div
            key={row.id}
            className={`card p-3.5 flex items-start gap-3 transition-all duration-500 ${
              pending ? 'opacity-50 grayscale border-emerald-200 bg-emerald-50' : 'opacity-100'
            }`}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap text-[11px] text-gray-400">
                <span className="font-mono">{formatDate(row.invoice_date) || '—'}</span>
                <span className="text-gray-300">·</span>
                <span className="text-gray-600 font-semibold truncate">{row.payee || '—'}</span>
                <SourceChip source={row.entry_source} />
                {row.category && (<>
                  <span className="text-gray-300">·</span>
                  <span className="text-gray-500">{row.category}</span>
                </>)}
                {/* For artist-column flags we surface the song for context;
                    for missing-song flags we surface the artist; for missing-
                    socials we surface both (artist + song are both useful
                    context when deciding whether a row needed handles). */}
                {kind === 'ledger_missing_song'
                  ? (row.artist && (<>
                      <span className="text-gray-300">·</span>
                      <span className="text-gray-500 truncate">{row.artist}</span>
                    </>))
                  : kind === 'ledger_missing_socials'
                  ? (<>
                      {row.artist && (<>
                        <span className="text-gray-300">·</span>
                        <span className="text-gray-500 truncate">{row.artist}</span>
                      </>)}
                      {row.song && (<>
                        <span className="text-gray-300">·</span>
                        <span className="text-gray-500 italic truncate">{row.song}</span>
                      </>)}
                      {row.cobrand && (<>
                        <span className="text-gray-300">·</span>
                        <span className="text-[10px] font-bold uppercase tracking-wide text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">Cobrand</span>
                      </>)}
                    </>)
                  : (row.song && (<>
                      <span className="text-gray-300">·</span>
                      <span className="text-gray-500 italic truncate">{row.song}</span>
                    </>))
                }
                {row.occurrence_count > 1 && (<>
                  <span className="text-gray-300">·</span>
                  <span className="text-gray-500">{row.occurrence_count} rows</span>
                </>)}
              </div>
              <div className="mt-1 flex items-center gap-2 flex-wrap text-sm">
                <span className="font-semibold text-rose-600">
                  {kind === 'ledger_missing_song'
                    ? '(no song)'
                    : kind === 'ledger_missing_socials'
                      ? '(no socials on file)'
                      : kind === 'artist_missing'
                        ? '(empty)'
                        : `"${row.artist || ''}"`}
                </span>
                {/* Inline fix-it input for missing-field rows. Enter or
                    click the inline ✓ button to commit; PUT goes to
                    /bk/entries/:id with the right column. Row drops out
                    of this list once saved. */}
                {isInlineEditable && (
                  <form
                    // Stable key per (row + kind) so React remounts the input
                    // when switching tabs and re-applies inlineDefault. Without
                    // this an uncontrolled input keeps the stale DOM value
                    // after a tab switch.
                    key={`${row.id}:${kind}:${inlineDefault}`}
                    onSubmit={(e) => {
                      e.preventDefault()
                      const v = e.currentTarget.elements.namedItem('fix')?.value || ''
                      onApplyMissingFix(kind, row.id, v)
                    }}
                    className="inline-flex items-center gap-1.5"
                  >
                    <span className="text-gray-400">→</span>
                    <input
                      name="fix"
                      type="text"
                      defaultValue={inlineDefault}
                      placeholder={kind === 'ledger_missing_song' ? 'Type song name' : 'Type artist name'}
                      disabled={busy}
                      className="px-2 py-1 text-xs border border-rule rounded-md bg-card focus:outline-none focus:ring-2 focus:ring-boom-400 min-w-[180px]"
                    />
                    <button
                      type="submit"
                      disabled={busy}
                      className="text-xs font-semibold px-2 py-1 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 inline-flex items-center gap-1"
                      title={`Save ${kind === 'ledger_missing_song' ? 'song' : 'artist'}`}
                    >
                      <Check size={11} /> {busy ? '…' : 'Save'}
                    </button>
                  </form>
                )}
                {kind === 'artist_placeholder' && onClearArtist && (
                  <button
                    onClick={() => onClearArtist(kind, row.id)}
                    disabled={busy}
                    title="This spend isn't for one artist — remove the placeholder and leave the field empty"
                    className="text-xs font-semibold px-2 py-1 rounded-md border border-rule text-gray-500 hover:text-ink hover:border-gray-300 disabled:opacity-40"
                  >
                    {busy ? '…' : 'No artist'}
                  </button>
                )}
                {kind === 'artist_multi_name' && Array.isArray(sug) && (
                  <span className="text-gray-500">
                    → split into {sug.map(s => `"${s}"`).join(', ')}
                  </span>
                )}
                {kind === 'artist_song_mismatch' && sug?.artist_name && (
                  <span className="text-gray-500">
                    → song "{sug.project_name}" is by <span className="font-semibold text-emerald-700">{sug.artist_name}</span>
                  </span>
                )}
                {(kind === 'artist_likely_typo' || kind === 'artist_variants') && sug?.artist_name && (
                  <span className="text-gray-500">
                    → suggested: <span className="font-semibold text-emerald-700">"{sug.artist_name}"</span>
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              {/* Pending state: the fix has been applied but the row is
                  still on-screen for a few seconds so the user can revert.
                  Replace Apply with Undo, hide the other actions. */}
              {pending ? (
                <button
                  onClick={() => onUndoFix(kind, row.id)}
                  disabled={busy}
                  title="Undo this fix"
                  className="text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-white text-emerald-700 border border-emerald-200 hover:bg-emerald-50 disabled:opacity-40 inline-flex items-center gap-1"
                >
                  <RotateCcw size={12} /> Undo
                </button>
              ) : (
                <>
                  {/* Per-row invoice preview. Only rendered when the entry
                      (or its split-family parent) has a file on disk so the
                      button doesn't lie. */}
                  {pickDoc(row) && onPreviewInvoice && (
                    <button
                      onClick={() => onPreviewInvoice(row)}
                      title="View invoice"
                      className="p-1.5 rounded text-gray-400 hover:text-blue-600 hover:bg-blue-50"
                    >
                      <FileText size={13} />
                    </button>
                  )}
                  {/* Split — opens the modal where the user can divide the
                      entry across N artists. Hidden on children of an existing
                      split (parent_id set) since you split parents, not
                      children, and on the missing-* kinds where splitting an
                      empty field doesn't make sense. */}
                  {onOpenSplit && !row.parent_id && kind !== 'artist_missing' && kind !== 'ledger_missing_song' && (
                    <button
                      onClick={() => onOpenSplit(kind, row)}
                      title={kind === 'artist_multi_name'
                        ? 'Split this invoice across the detected artists'
                        : 'Split this invoice across multiple artists'}
                      className="text-xs font-semibold px-2 py-1 rounded-md text-boom-700 bg-boom-50 hover:bg-boom-100 border border-boom-200 inline-flex items-center gap-1"
                    >
                      <Copy size={11} /> Split
                    </button>
                  )}
                  <Link
                    to={`/bk/ledger?focus=${row.id}`}
                    title="Open in ledger"
                    className="p-1.5 rounded text-gray-400 hover:text-boom-600 hover:bg-boom-50"
                  >
                    <ExternalLink size={13} />
                  </Link>
                  <button
                    onClick={() => onDismiss(kind, row.id)}
                    disabled={busy}
                    title="Dismiss this flag"
                    className="p-1.5 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 disabled:opacity-40"
                  >
                    <X size={13} />
                  </button>
                </>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Section: dismissed artist flags — separate read-only list with restore. ─
function DismissedArtistFlagsSection({ rows, busyEntryId, onRestore }) {
  if (!rows.length) {
    return (
      <div className="card p-5 text-center text-xs text-gray-400">
        No dismissed artist flags.
      </div>
    )
  }
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">Dismissed ({rows.length})</p>
      {rows.map(r => {
        const busy = busyEntryId === r.entry_id
        return (
          <div key={`${r.entry_id}-${r.flag_kind}`} className="card p-3 flex items-center gap-3 opacity-80">
            <div className="flex-1 min-w-0 text-xs">
              <div className="text-gray-400">
                {formatDate(r.invoice_date) || '—'} · {r.payee || '—'} <SourceChip source={r.entry_source} className="ml-1" />
                {r.category ? ` · ${r.category}` : ''}
                {r.song ? ` · ${r.song}` : ''}
              </div>
              <div className="mt-0.5">
                <span className="font-semibold text-gray-700">"{r.artist || '—'}"</span>
                <span className="text-gray-400"> — flagged as </span>
                <span className="font-mono text-gray-500">{r.flag_kind}</span>
                <span className="text-gray-400"> · dismissed {r.dismissed_by_name ? `by ${r.dismissed_by_name}` : ''} {formatDate(r.dismissed_at) || ''}</span>
              </div>
            </div>
            <button
              onClick={() => onRestore(r.entry_id, r.flag_kind)}
              disabled={busy}
              title="Restore this flag"
              className="text-xs font-semibold px-2.5 py-1.5 rounded-lg border border-rule text-gray-600 hover:bg-gray-50 disabled:opacity-40 inline-flex items-center gap-1"
            >
              <Undo2 size={12} /> Restore
            </button>
          </div>
        )
      })}
    </div>
  )
}
