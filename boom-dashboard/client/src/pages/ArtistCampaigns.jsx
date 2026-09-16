import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useParams, Link, useNavigate, useLocation } from 'react-router-dom'
import {
  ChevronRight, ChevronDown, ArrowLeft, AtSign, Link2, Unlink, X,
  AlertTriangle, CheckCircle2, Music2, Megaphone, Search, Plus, Trash2, Edit2,
  EyeOff, Eye, Undo2, FileText, GitBranch, Circle, Archive, ArchiveRestore,
  Sparkles, Download, Loader, Pencil, MessageSquare, ExternalLink, Package, FolderOpen,
} from 'lucide-react'
import api from '../api'
import ArtistSelect from '../components/ArtistSelect'
import ArtistCampaignsQueue from './ArtistCampaignsQueue'
import PayeeLink from '../components/PayeeLink'
import PageHeader from '../components/PageHeader'
import Skeleton from '../components/Skeleton'
import FilePreview from '../components/FilePreview'
import FlagButton from '../components/FlagButton'
import HoverTip from '../components/HoverTip'
import CampaignReviewInbox from '../components/CampaignReviewInbox'
import CampaignChat from '../components/CampaignChat'
import RoomCommentThread from '../components/RoomCommentThread'
import AssignReviewersButton from '../components/AssignReviewersButton'
import { SOCIAL_PLATFORMS, CATEGORIES } from '../constants'
import { useCategories } from '../context/CategoriesContext'
import { formatDate, normalizeArtistKey, familyArtists, filterSocialsForArtist } from '../utils'
import { useToast } from '../context/ToastContext'
import { useAuth } from '../context/AuthContext'
import { useFxRates } from '../context/FxRatesContext'

// ── Currency helpers ────────────────────────────────────────────────────────
// influencer_campaigns.total_budget is unscoped (no currency column), so the
// page treats it as USD throughout. Ledger rows keep their per-row currency
// so we don't silently mix EUR/GBP into USD totals.
const fmt = (v, cur = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD' }).format(Number(v) || 0)

const fmtCompact = (v) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Math.round(Number(v) || 0))

// Sum a list of ledger rows into { CUR: total } so a $500 + €300 row don't
// collapse into one number. Mirrors Recoupments.groupByCurrency().
const groupByCurrency = (list) => {
  const map = {}
  for (const e of list) {
    if (!e?.amount) continue
    const cur = (e.currency || 'USD').toUpperCase()
    map[cur] = (map[cur] || 0) + parseFloat(e.amount || 0)
  }
  return map
}
const fmtTotals = (totals) => {
  const parts = Object.entries(totals).filter(([, v]) => v)
  if (!parts.length) return fmt(0)
  parts.sort(([a], [b]) => a === 'USD' ? -1 : b === 'USD' ? 1 : a.localeCompare(b))
  return parts.map(([cur, v]) => fmt(v, cur)).join(' + ')
}

// Normalize social_handles JSONB into a flat list of usable rows for
// Categories that actually make sense to attach socials to. Kept in
// sync with the missing-socials flag on the server (routes/flags.js —
// getMissingSocialsFlags). Cobrand rows also count regardless of
// category, mirroring the server rule. Used to (a) mute the "Add
// socials" button on rows where socials don't matter and (b) skip
// non-social categories in the "N missing" counts so the chip is
// meaningful instead of alarming.
const SOCIALS_CATEGORIES = new Set(['Marketing', 'PR'])
const rowNeedsSocials = (e) =>
  SOCIALS_CATEGORIES.has(e?.category) || !!e?.cobrand

// rendering. Mirrors Recoupments.socialsList().
const socialsList = (raw) => {
  if (!Array.isArray(raw)) return []
  return raw
    .map(s => {
      const platform = (s?.platform || '').trim()
      const handle = (s?.handle || '').trim()
      if (!handle) return null
      return { platform, handle, amount: s?.amount, display: (platform ? `${platform} ${handle}` : handle) + (s?.amount ? ` · $${s.amount}` : '') }
    })
    .filter(Boolean)
}

// Resolve which socials a row should *display*. Split children (parent_id)
// inherit from the parent invoice — the JSONB only lives on the parent row
// itself. Server side, the artist-campaigns endpoint surfaces both columns.
// Both sources are filtered to the row's artist so tagged handles only
// surface on the artist they belong to; untagged handles pass through
// (shared across every artist on the invoice).
const rowSocials = (entry) => {
  const own = socialsList(filterSocialsForArtist(entry.social_handles, entry.artist))
  if (own.length) return { handles: own, fromParent: false }
  if (entry.parent_id) {
    const parent = socialsList(filterSocialsForArtist(entry.parent_social_handles, entry.artist))
    if (parent.length) return { handles: parent, fromParent: true }
  }
  return { handles: [], fromParent: false }
}

// Canonical "no song" placeholder. Empty/whitespace song fields all collapse
// into one bucket so users see every artist-only spend in one place rather
// than scattered across "(empty)" / "" / null variants.
const SONG_UNASSIGNED = '(no song)'
// URL slug for the "(no song)" bucket so its subpage doesn't render
// "%28no%20song%29" in the address bar and doesn't collide with a real
// song called "(no song)". Chosen with underscore prefixes so it can't
// accidentally match a real song title on the ledger.
const NO_SONG_SLUG = '__no-song__'
const encodeSongForUrl = (song) =>
  song === SONG_UNASSIGNED ? NO_SONG_SLUG : encodeURIComponent(song)
const decodeSongFromUrl = (slug) =>
  slug === NO_SONG_SLUG ? SONG_UNASSIGNED : slug

// Case-insensitive bucket key so "The Jawn" / "The JAWN" / "the jawn" all
// merge into one group. Display-name resolution (best spelling wins) lives
// on the songGroups builder — matches the existing artist-name pattern
// documented in CLAUDE.md ("The most common spelling is used as the
// displayed name").
const songKey = (s) => {
  const t = (s || '').trim().toLowerCase()
  return t || SONG_UNASSIGNED
}

// FlagButton lives at ../components/FlagButton — extracted so BkLedger
// and BkApprovals can render the same chip.

export default function ArtistCampaigns() {
  // Live expense categories. Bound to the same name the module-level
  // import used, so every CATEGORIES reference in this component now
  // reads the vocabulary from context (which falls back to that same
  // constant if the fetch fails). Categories are user-created on the
  // Statements and Reports pages — a hardcoded list here would leave
  // this dropdown unable to render its own rows' values.
  const CATEGORIES = useCategories()
  // Current user — comment threads use it to gate delete-own-comment
  // (server enforces the same rule; this is just the affordance).
  const { user: currentUser } = useAuth()
  // USD-equivalent for one entry: locked fx first (stamped at payment),
  // then the cached daily ECB rate for foreign rows — never a silent 1:1.
  const { rates: fxRates } = useFxRates()
  const entryUsd = useCallback((e) => {
    const native = parseFloat(e.amount || 0)
    const locked = parseFloat(e.fx_rate_to_usd || 0)
    if (locked > 0) return native / locked
    const cur = (e.currency || 'USD').toUpperCase()
    if (cur === 'USD') return native
    const live = fxRates?.[cur]
    return live > 0 ? native / live : native
  }, [fxRates])
  // URL drives the view:
  //   /artist-campaigns                            → index (artist cards)
  //   /artist-campaigns/:artistName                → artist detail
  //   /artist-campaigns/:artistName/:songName      → song subpage
  const { artistName: artistParam, songName: songParam } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const chatLocation = useLocation()
  const routeArtist = artistParam ? decodeURIComponent(artistParam) : ''
  const routeSong   = songParam   ? decodeSongFromUrl(decodeURIComponent(songParam)) : ''
  const isDetail = !!routeArtist
  const isSong   = !!routeSong

  // ── Index state ─────────────────────────────────────────────────────────
  const [indexRows, setIndexRows] = useState([])
  // SETTLED spend is what the statements show, so it needs a period — a page
  // that leads with the bank cannot be "all time". Defaults to YTD, matching the
  // Reports page. COMMITTED is deliberately unbounded: an invoice dated last
  // November and still unpaid belongs in the forward view, and hiding it behind a
  // date filter would make the second number mean something else.
  const [range, setRange] = useState(() => {
    const to = new Date().toISOString().slice(0, 10)
    return { from: `${to.slice(0, 4)}-01-01`, to }
  })
  const [indexMeta, setIndexMeta] = useState(null)
  // The catch-up queue is a VIEW of this page, not a route of its own:
  // AuthContext.canView matches location.pathname exactly and ends in
  // `return false`, so /artist-campaigns/queue would be invisible to every
  // non-admin until somebody added a fourth carve-out beside /flags,
  // /bk/bank-matching and /bk/bank-ledger. A query parameter inherits this
  // page's permission, and stays linkable + back-button-able.
  const queueView = new URLSearchParams(chatLocation.search).get('view') === 'queue'
  // The unattributed queue. Campaign spend the STATEMENTS show that names no
  // artist — the gap a statement-centric page would otherwise just describe.
  // Rows come from the Reports artist drill (kind=artist with an empty key IS
  // the unattributed bucket), one call per campaign category, and the write is
  // /reports/set-artist, which is part-aware: a split payment's slice is
  // attributed on its own without touching the rest of the payment.
  const [queue, setQueue] = useState(null)       // { rows, loading, error }
  const [queueSel, setQueueSel] = useState(() => new Set())
  const [queueArtist, setQueueArtist] = useState('')
  const [queueBusy, setQueueBusy] = useState(false)
  // Assigning part of the ad pool to an artist. The charges carry no artist
  // evidence — that is why the pool exists — but John knows what the ads were
  // for, and an allocation is where that knowledge goes. It MOVES money: the
  // artist's total rises, the pool's falls, the P&L is untouched.
  const [adPool, setAdPool] = useState(null)     // { month, data, loading }
  const [adForm, setAdForm] = useState({ artist: '', amount: '', note: '' })
  const [adBusy, setAdBusy] = useState(false)
  const [roster, setRoster] = useState([])
  const [indexLoading, setIndexLoading] = useState(true)
  const [indexQuery, setIndexQuery] = useState('')
  // Per-artist priority meta. Map keyed by lowercased artist name.
  // Independent from the Recoupments table — campaign reconciliation
  // priority can differ from recoupment priority for the same artist.
  const [campaignMeta, setCampaignMeta] = useState({}) // { lower(name): { priority, ... } }

  // Song-campaign finished flag — { "<artistKey>|<songKey>": row }. Mirrors
  // the shape the server returns from /bk/song-status. Refetched on detail
  // load alongside the ledger so the song-group headers and the
  // Recoupments badge stay consistent.
  const [songStatus, setSongStatus] = useState({})
  const [songStatusLoading, setSongStatusLoading] = useState(true)
  const songFinishedKey = (artistName, songName) =>
    `${normalizeArtistKey(artistName)}|${String(songName || '').toLowerCase().trim()}`
  const isSongFinished = (artistName, songName) => {
    const k = songFinishedKey(artistName, songName)
    return !!songStatus[k]?.finished
  }
  const getSongNotes = (artistName, songName) => {
    const k = songFinishedKey(artistName, songName)
    return songStatus[k]?.notes || ''
  }
  // Flag-for-review lookups. Song-level lives in songStatus; artist-
  // level lives in campaignMeta. Rollup: an artist is considered
  // "flagged" for display when the artist itself is flagged OR any
  // of its songs are flagged.
  const isSongFlagged = (artistName, songName) => {
    const k = songFinishedKey(artistName, songName)
    return !!songStatus[k]?.flagged
  }
  const getSongFlagReason = (artistName, songName) => {
    const k = songFinishedKey(artistName, songName)
    return songStatus[k]?.flag_reason || ''
  }
  const isArtistExplicitlyFlagged = (artistName) => {
    const key = (artistName || '').toLowerCase().trim()
    return !!campaignMeta[key]?.flagged
  }
  const getArtistFlagReason = (artistName) => {
    const key = (artistName || '').toLowerCase().trim()
    return campaignMeta[key]?.flag_reason || ''
  }
  // Roll up any-song-flagged for a given artist. Keyed by the
  // normalized artist_key — same normalization the server uses for
  // song_campaign_status.artist_key.
  const flaggedSongCountForArtist = (artistName) => {
    const aKey = normalizeArtistKey(artistName)
    let count = 0
    for (const k in songStatus) {
      if (!songStatus[k]?.flagged) continue
      // songStatus keys are "artist_key|song_key". Only match on the
      // artist_key prefix so a song key that happens to start the same
      // way (unlikely, but safe) doesn't false-match.
      const parts = k.split('|')
      if (parts[0] === aKey) count++
    }
    return count
  }
  const isArtistFlaggedRolledUp = (artistName) =>
    isArtistExplicitlyFlagged(artistName) || flaggedSongCountForArtist(artistName) > 0

  // Notes editor state — only used on the song subpage. Kept as a
  // separate draft so blurring saves the exact string the user typed,
  // even if songStatus refetches mid-edit.
  const [notesDraft, setNotesDraft] = useState('')
  const [notesSaving, setNotesSaving] = useState(false)
  // True once the user types into the notes textarea; cleared on route
  // change and successful save. Guards the songStatus→draft sync effect.
  const notesDirtyRef = useRef(false)

  // ── Detail state ────────────────────────────────────────────────────────
  const [detail, setDetail] = useState(null) // { artist, ledger, campaigns }
  const [detailLoading, setDetailLoading] = useState(false)
  const [collapsedSongs, setCollapsedSongs] = useState(() => new Set())
  const toggleSong = (k) => setCollapsedSongs(prev => {
    const next = new Set(prev)
    next.has(k) ? next.delete(k) : next.add(k)
    return next
  })

  // ── Socials inline editor (popover) ─────────────────────────────────────
  const [socialsModal, setSocialsModal] = useState(null) // { entryId }
  const [socialsRows, setSocialsRows] = useState([])
  const [socialsSaving, setSocialsSaving] = useState(false)

  // ── Link campaign → expense modal ───────────────────────────────────────
  const [linkModal, setLinkModal] = useState(null) // { campaign }
  const [linkSelected, setLinkSelected] = useState('')
  const [linkSearch, setLinkSearch] = useState('')
  const [linkSaving, setLinkSaving] = useState(false)

  // ── Per-row edit modal (artist / song / category) ──────────────────────
  // Unified instead of three separate modals — the three fields tend to be
  // fixed together (re-categorizing a misfiled spend usually means setting
  // a new artist + song too). PUTs only the fields that actually changed.
  const [editModal, setEditModal] = useState(null) // { entry, draft }
  const [editSaving, setEditSaving] = useState(false)

  // ── Split-invoice modal ─────────────────────────────────────────────────
  // Custom split of one invoice across multiple songs with user-chosen
  // amounts (e.g. a $1,200 invoice → Song A $400 + Song B $800). Hits the
  // existing POST /api/bk/entries/:id/split endpoint with the structured
  // artist_breakdown payload. Splits are non-destructive in concept (the
  // server creates child rows + keeps the parent), so undo just runs the
  // existing DELETE /entries/:id/splits.
  const [splitModal, setSplitModal] = useState(null) // { entry, rows: [{ song, amount }] }
  const [splitSaving, setSplitSaving] = useState(false)

  // ── Show-dismissed toggle + dismissed tray ──────────────────────────────
  // When true the page re-fetches with ?include_dismissed=true so dismissed
  // rows render with a "Restore" affordance. Kept off the URL so a deep-link
  // to /artist-campaigns/:artist always lands on the cleaned-up view.
  const [showDismissed, setShowDismissed] = useState(false)

  // ── Undo toast ──────────────────────────────────────────────────────────
  // Mirrors the Recoupments showUndo() pattern: a 10s window where the
  // latest mutation can be reversed via the toast. Only one pending undo
  // at a time — a new mutation commits the prior one for good. The Undo2
  // import above is just the icon.
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

  // ── Invoice preview ─────────────────────────────────────────────────────
  // Same FilePreview component / endpoint shape as Recoupments. For split
  // children the invoice lives on the parent row, so the URL uses
  // parent_id || id when the child has no own file.
  const [previewFile, setPreviewFile] = useState(null) // { url, filename } | null
  const invoiceUrl = (entry) => {
    const id = (!entry.has_invoice && entry.parent_id) ? entry.parent_id : entry.id
    return `/api/bk/entries/${id}/file/invoice?token=${localStorage.getItem('token')}`
  }
  const hasInvoiceFile = (entry) =>
    !!(entry.has_invoice || (entry.parent_id && entry.parent_has_invoice))

  // Initial fetch — index or detail depending on the route.
  useEffect(() => {
    let cancelled = false
    if (!isDetail) {
      setIndexLoading(true)
      api.get('/artist-campaigns', { params: { from: range.from, to: range.to } })
        .then(r => {
          if (cancelled) return
          setIndexRows(r.data?.data || [])
          setIndexMeta(r.data?.meta || null)
        })
        .catch(err => console.error('GET /artist-campaigns:', err))
        .finally(() => { if (!cancelled) setIndexLoading(false) })
      // Meta fetched alongside index. Now hits the unified
      // /bk/artist-meta endpoint shared with Recoupments — priority for
      // an artist is the same on both pages. Tolerant of failure (page
      // still renders without priority chips); logs so silent failures
      // surface.
      api.get('/bk/artist-meta')
        .then(r => { if (!cancelled) setCampaignMeta(r.data?.data || {}) })
        .catch(err => console.warn('Failed to fetch artist meta:', err?.response?.data?.error || err.message))
      // Song-campaign finished flags. Same source the Recoupments page
      // reads so a toggle on either page surfaces on the other.
      api.get('/bk/song-status')
        .then(r => { if (!cancelled) setSongStatus(r.data?.data || {}) })
        .catch(err => console.warn('Failed to fetch song status:', err?.response?.data?.error || err.message))
        .finally(() => { if (!cancelled) setSongStatusLoading(false) })
    } else {
      setDetailLoading(true)
      setDetail(null)
      const qs = showDismissed ? '?include_dismissed=true' : ''
      api.get(`/artist-campaigns/${encodeURIComponent(routeArtist)}${qs}`)
        .then(r => { if (!cancelled) setDetail(r.data?.data || null) })
        .catch(err => console.error('GET /artist-campaigns/:artist:', err))
        .finally(() => { if (!cancelled) setDetailLoading(false) })
      // Song status mirrors the artist-meta fetch in the index branch.
      api.get('/bk/song-status')
        .then(r => { if (!cancelled) setSongStatus(r.data?.data || {}) })
        .catch(err => console.warn('Failed to fetch song status:', err?.response?.data?.error || err.message))
        .finally(() => { if (!cancelled) setSongStatusLoading(false) })
      // Artist meta on the detail page too — the header's ready-for-
      // planning toggle reads/writes it (shared with Recoupments).
      api.get('/bk/artist-meta')
        .then(r => { if (!cancelled) setCampaignMeta(r.data?.data || {}) })
        .catch(() => {})
    }
    return () => { cancelled = true }
  }, [isDetail, routeArtist, showDismissed, range.from, range.to])

  // Suggestions only — ArtistSelect accepts a name it has never heard of, which
  // is the normal case: ~90 names appear in the ledger against 50 on the roster.
  // Same endpoint and same fallback as the Reports drill.
  useEffect(() => {
    api.get('/bk/artist-names')
      .then((r) => { const l = r.data?.data?.names ?? []; setRoster(Array.isArray(l) ? l : []) })
      .catch(() => api.get('/artists')
        .then((r) => { const l = r.data?.data ?? r.data ?? []; setRoster(Array.isArray(l) ? l.map((a) => a.name).filter(Boolean) : []) })
        .catch(() => {}))
  }, [])

  const openQueue = async () => {
    const cats = indexMeta?.scope?.categories || []
    setQueue({ rows: [], loading: true, error: null })
    setQueueSel(new Set()); setQueueArtist('')
    try {
      const results = await Promise.all(cats.map((c) => api.get('/reports/pnl/detail', {
        params: { kind: 'artist', key: '', category: c, from: range.from, to: range.to },
      }).then((r) => ({ cat: c, d: r.data?.data || {} }))))
      // Biggest first: the queue is worked from the top, and $40k of one payment
      // is worth more attention than 60 rows of $12.
      const rows = results
        .flatMap(({ cat, d }) => (d.rows || []).map((x) => ({ ...x, __cat: cat })))
        .sort((a, b) => (Number(b.usd) || 0) - (Number(a.usd) || 0))
      // The drill hands back DEBITS in `rows` and reimbursements received in a
      // separate `recoveries` block. The band above nets them off, exactly as the
      // P&L does — so listing the debits alone would show MORE money than the
      // figure it was opened from ($52,374.13 of Marketing reimbursements, on the
      // live report). Carried here so the header can state the difference instead
      // of leaving two numbers that should match and don't.
      const recoveries = results.reduce((a, { d }) => ({
        count: a.count + (d.recoveries?.count || 0),
        total: a.total + (Number(d.recoveries?.total) || 0),
      }), { count: 0, total: 0 });
      // Nothing here is attributable if it was never booked, and the cap would
      // make the list a subset without saying so.
      const truncated = results.filter(({ d }) => d.truncated)
        .map(({ cat, d }) => `${cat}: ${d.rows.length} of ${d.row_count}`);
      setQueue({ rows, recoveries, truncated, loading: false, error: null })
    } catch (err) {
      setQueue({ rows: [], loading: false, error: err.response?.data?.error || err.message })
    }
  }

  // "These can never name an artist." One rule per VENDOR, from the payees in the
  // selection — a Spotify ad account bills the label, so 168 charges are one
  // decision rather than 168. Reversible: the rules are listed on the Rules page
  // and deleting one puts its spend straight back.
  const markLabelLevel = async () => {
    if (queueBusy || !queue?.rows?.length) return
    const chosen = queue.rows.filter((r) => queueSel.has(r.id))
    const vendors = [...new Set(chosen.map((r) => String(r.payee || '').trim()).filter(Boolean))]
    if (!vendors.length) return
    const covered = queue.rows.filter((r) => vendors.includes(String(r.payee || '').trim()))
    const money = covered.reduce((t, r) => t + (Number(r.usd) || 0), 0)
    if (!window.confirm(
      `Mark as label-level — spend that bills the label, not a release:\n\n${vendors.join('\n')}\n\n`
      + `This covers ${covered.length} row${covered.length === 1 ? '' : 's'} in this queue `
      + `(${fmtCompact(money)}), and every future charge from the same payees.\n\n`
      + 'It moves no money: the spend leaves "names no artist" and is disclosed as the ad pool. '
      + 'Deleting the rule puts it back.')) return
    setQueueBusy(true)
    try {
      await api.post('/reports/label-level-rules', { scope: 'vendor', keys: vendors })
      await openQueue()
      const r = await api.get('/artist-campaigns', { params: { from: range.from, to: range.to } })
      setIndexRows(r.data?.data || []); setIndexMeta(r.data?.meta || null)
    } catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
    finally { setQueueBusy(false) }
  }

  const openAdPool = async (month) => {
    const m = month || String(range.to || '').slice(0, 7)
    setAdPool({ month: m, data: null, loading: true })
    setAdForm({ artist: '', amount: '', note: '' })
    try {
      const { data } = await api.get('/reports/ad-pool', { params: { month: m } })
      setAdPool({ month: m, data: data?.data || null, loading: false })
    } catch (err) {
      setAdPool({ month: m, data: null, loading: false, error: err.response?.data?.error || err.message })
    }
  }
  const refreshAfterPool = async () => {
    await openAdPool(adPool?.month)
    const r = await api.get('/artist-campaigns', { params: { from: range.from, to: range.to } })
    setIndexRows(r.data?.data || []); setIndexMeta(r.data?.meta || null)
  }
  const addAllocation = async () => {
    const amount = Number(String(adForm.amount).replace(/[^0-9.]/g, ''))
    if (!adForm.artist || !(amount > 0) || adBusy) return
    setAdBusy(true)
    try {
      await api.post('/reports/ad-pool', {
        artist: adForm.artist, month: adPool.month, amount, note: adForm.note || undefined,
      })
      await refreshAfterPool()
    } catch (err) {
      // The server refuses an over-assignment and says what is left, rather than
      // trimming it silently on every future read. Show that verbatim.
      alert(err.response?.data?.error || err.message)
    } finally { setAdBusy(false) }
  }
  const removeAllocation = async (id) => {
    if (adBusy) return
    setAdBusy(true)
    try { await api.delete(`/reports/ad-pool/${id}`); await refreshAfterPool() }
    catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
    finally { setAdBusy(false) }
  }

  const applyQueueArtist = async () => {
    if (!queueArtist || queueBusy || !queue?.rows?.length) return
    const chosen = queue.rows.filter((r) => queueSel.has(r.id))
    // The PART ids, not the family root — a payment split across two artists
    // must not have both slices dragged onto one name.
    const ids = [...new Set(chosen.flatMap((r) => (
      Array.isArray(r.part_expense_ids) && r.part_expense_ids.length
        ? r.part_expense_ids
        : (r.expense_id ? [r.expense_id] : []))))]
    if (!ids.length) { alert('None of the selected rows has a ledger entry to attribute. Book them first on Bank Matching.'); return }
    setQueueBusy(true)
    try {
      const { data } = await api.post('/reports/set-artist', { expense_ids: ids, artist: queueArtist })
      if (data.data?.skipped) {
        alert(`${data.data.updated} of ${data.data.requested} updated — ${data.data.skipped} had changed underneath (deleted or voided).`)
      }
      // Both surfaces move: the cards gain the money, the queue loses the rows.
      await openQueue()
      const r = await api.get('/artist-campaigns', { params: { from: range.from, to: range.to } })
      setIndexRows(r.data?.data || []); setIndexMeta(r.data?.meta || null)
    } catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
    finally { setQueueBusy(false) }
  }

  // Refetch on window focus so two people working the same artist don't
  // act on stale rows (flags/checks/comments land from teammates while a
  // tab sits in the background). Throttled to once per 30s.
  useEffect(() => {
    if (!isDetail || !routeArtist) return
    let last = Date.now()
    const onFocus = () => {
      if (Date.now() - last < 30000) return
      last = Date.now()
      const qs = showDismissed ? '?include_dismissed=true' : ''
      api.get(`/artist-campaigns/${encodeURIComponent(routeArtist)}${qs}`)
        .then(r => setDetail(r.data?.data || null))
        .catch(() => {})
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [isDetail, routeArtist, showDismissed])

  // ── Socials editor handlers ─────────────────────────────────────────────
  const openSocialsEditor = (entry) => {
    // Split children display the PARENT's socials — the JSONB lives on the
    // parent row. When a child with no socials of its own is clicked,
    // retarget the editor at the parent (seeded from the parent's handles,
    // saved to the parent's id). The old "edit on the parent row" tooltip
    // was a dead end: split families bucket per-song here, so the parent
    // is often not even visible on this page. The parent row may be
    // missing from detail.ledger entirely — fall back to the child's
    // parent_social_handles copy the endpoint sends along.
    const ownHandles = Array.isArray(entry.social_handles) ? entry.social_handles : []
    const parentRow = entry.parent_id
      ? (detail?.ledger || []).find(e => e.id === entry.parent_id)
      : null
    const editingParent = !!entry.parent_id && ownHandles.length === 0
    const targetId = editingParent ? entry.parent_id : entry.id
    const existing = editingParent
      ? (Array.isArray(parentRow?.social_handles) ? parentRow.social_handles
         : Array.isArray(entry.parent_social_handles) ? entry.parent_social_handles : [])
      : ownHandles
    setSocialsRows(existing.length
      ? existing.map(s => ({ platform: s?.platform || 'Instagram', handle: s?.handle || '', artist: s?.artist || '', amount: s?.amount ?? '' }))
      // Blank editor opened from a child row: pre-tag the first handle to
      // that child's artist so it surfaces on the row the user clicked
      // (untagged handles show on every artist in the family).
      : [{ platform: 'Instagram', handle: '', artist: editingParent ? (entry.artist || '') : '', amount: '' }])
    // Carry the family into the modal so a split invoice can tag each
    // social row with the artist it belongs to. Also stash the previous
    // handles + a display label — the undo path can't rely on finding the
    // target row in detail.ledger when we retargeted to an off-page parent.
    // Family list for the "For artist" selector — union of the split
    // family, the clicked row's artist, and any artist tags already on
    // the handles. The last two matter when the parent row lives on a
    // DIFFERENT artist's page (family invisible from here): without
    // them the selector hid entirely, leaving a wrong artist tag both
    // invisible and unfixable (a handle tagged to artist A never
    // renders on artist B's split child).
    const seen = new Map()
    for (const a of [
      ...familyArtists(parentRow || entry),
      (entry.artist || '').trim(),
      ...existing.map(s => (s?.artist || '').trim()),
    ]) {
      if (!a) continue
      const k = a.toLowerCase()
      if (!seen.has(k)) seen.set(k, a)
    }
    setSocialsModal({
      entryId: targetId,
      familyArtists: [...seen.values()],
      // New rows added from a child default to that child's artist so a
      // handle typed here surfaces on the row the user clicked.
      defaultArtist: editingParent ? (entry.artist || '') : '',
      prevHandles: existing,
      payeeLabel: entry.payee || `#${targetId}`,
    })
  }
  const saveSocials = async () => {
    if (!socialsModal) return
    const cleaned = socialsRows
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
    setSocialsSaving(true)
    // Patch the edited row AND every split child that inherits from it —
    // children render parent_social_handles, so without this the chips
    // wouldn't update until a refetch.
    const applyHandles = (handles) => setDetail(prev => prev ? {
      ...prev,
      ledger: prev.ledger.map(e => {
        if (e.id === socialsModal.entryId) return { ...e, social_handles: handles }
        if (e.parent_id === socialsModal.entryId) return { ...e, parent_social_handles: handles }
        return e
      }),
    } : prev)
    try {
      const entryId = socialsModal.entryId
      const prevHandles = Array.isArray(socialsModal.prevHandles) ? socialsModal.prevHandles : []
      const label = socialsModal.payeeLabel || `#${entryId}`
      await api.put(`/bk/entries/${entryId}`, { social_handles: cleaned })
      applyHandles(cleaned)
      setSocialsModal(null)
      showUndo(`Updated socials for "${label}"`, async () => {
        await api.put(`/bk/entries/${entryId}`, { social_handles: prevHandles })
        applyHandles(prevHandles)
      })
    } catch (err) {
      console.error('save socials:', err)
      alert('Failed to save socials: ' + (err.response?.data?.error || err.message))
    } finally {
      setSocialsSaving(false)
    }
  }

  // ── Link/unlink handlers ────────────────────────────────────────────────
  const openLinkModal = (campaign) => {
    setLinkSelected('')
    setLinkSearch('')
    setLinkModal({ campaign })
  }
  const saveLink = async () => {
    if (!linkModal || !linkSelected) return
    setLinkSaving(true)
    try {
      const campaign = linkModal.campaign
      const newExpenseId = Number(linkSelected)
      await api.post('/artist-campaigns/link', { campaign_id: campaign.id, expense_id: newExpenseId })
      setDetail(prev => prev ? {
        ...prev,
        campaigns: prev.campaigns.map(c =>
          c.id === campaign.id ? { ...c, expense_id: newExpenseId } : c
        ),
        ledger: prev.ledger.map(e =>
          e.id === newExpenseId
            ? { ...e, campaign_id: campaign.id, campaign_name: campaign.name }
            : e
        ),
      } : prev)
      setLinkModal(null)
      showUndo(`Linked "${campaign.name}"`, async () => {
        await api.post('/artist-campaigns/link', { campaign_id: campaign.id, expense_id: null })
        setDetail(prev => prev ? {
          ...prev,
          campaigns: prev.campaigns.map(c => c.id === campaign.id ? { ...c, expense_id: null } : c),
          ledger: prev.ledger.map(e =>
            e.id === newExpenseId ? { ...e, campaign_id: null, campaign_name: null } : e
          ),
        } : prev)
      })
    } catch (err) {
      console.error('link campaign:', err)
      alert('Failed to link: ' + (err.response?.data?.error || err.message))
    } finally {
      setLinkSaving(false)
    }
  }
  // ── Edit-row handlers ───────────────────────────────────────────────────
  const openEditModal = (entry) => {
    setEditModal({
      entry,
      draft: {
        artist: entry.artist || '',
        song: entry.song || '',
        category: entry.category || '',
        // Amount as a plain string so the input can host partial values
        // ("12.") mid-edit without React rejecting the intermediate state.
        // Cast back to Number in saveEdit.
        amount: entry.amount != null ? String(entry.amount) : '',
      },
    })
  }
  const setEditDraft = (patch) =>
    setEditModal(prev => prev ? { ...prev, draft: { ...prev.draft, ...patch } } : prev)
  const saveEdit = async () => {
    if (!editModal) return
    const { entry, draft } = editModal
    const trimmed = {
      artist: draft.artist.trim(),
      song: draft.song.trim(),
      category: draft.category.trim(),
      amount: (draft.amount ?? '').toString().trim(),
    }
    if (!trimmed.category) {
      alert('Category is required.')
      return
    }
    // Amount validation. Non-empty check + parse. Reject NaN and negative
    // values (server would reject them anyway, but a client-side guard
    // gives a nicer error). Zero is allowed — it's used occasionally
    // for placeholder / TBD rows.
    let amountNum = null
    if (trimmed.amount !== '') {
      amountNum = parseFloat(trimmed.amount)
      if (!Number.isFinite(amountNum) || amountNum < 0) {
        alert('Amount must be a non-negative number.')
        return
      }
    } else {
      alert('Amount is required.')
      return
    }
    // PUT only the fields that actually changed. Same endpoint the Ledger
    // and Recoupments pages use — auto-link to releases + audit log run
    // server-side on the touched fields.
    const patch = {}
    if (trimmed.artist !== (entry.artist || '')) patch.artist = trimmed.artist
    if (trimmed.song   !== (entry.song   || '')) patch.song   = trimmed.song
    if (trimmed.category !== (entry.category || '')) patch.category = trimmed.category
    // Compare amounts as numbers with a small tolerance — the original
    // value may round-trip through Postgres as "1000.00" but the input
    // yields "1000", and we don't want an accidental no-op PUT.
    const originalAmount = entry.amount != null ? parseFloat(entry.amount) : null
    if (originalAmount == null || Math.abs(originalAmount - amountNum) > 0.005) {
      patch.amount = amountNum
    }
    if (!Object.keys(patch).length) { setEditModal(null); return }

    setEditSaving(true)
    try {
      await api.put(`/bk/entries/${entry.id}`, patch)

      // The page shows every category now, so the only edit that filters a
      // row off the local view is changing artist. Category changes stay
      // in place.
      const stillThisArtist = !patch.artist
        || normalizeArtistKey(patch.artist) === normalizeArtistKey(detail.artist)

      setDetail(prev => prev ? {
        ...prev,
        ledger: stillThisArtist
          ? prev.ledger.map(e => e.id === entry.id ? { ...e, ...patch } : e)
          : prev.ledger.filter(e => e.id !== entry.id),
      } : prev)
      setEditModal(null)

      // Undo restores every changed field. If the row was filtered off the
      // local view (artist swap), refetch so it comes back in the right
      // bucket.
      const undoPatch = {}
      for (const k of Object.keys(patch)) undoPatch[k] = entry[k] || null
      const rowMovedAway = !stillThisArtist
      showUndo(`Updated "${entry.payee || `#${entry.id}`}"`, async () => {
        await api.put(`/bk/entries/${entry.id}`, undoPatch)
        if (rowMovedAway) {
          const qs = showDismissed ? '?include_dismissed=true' : ''
          const r = await api.get(`/artist-campaigns/${encodeURIComponent(routeArtist)}${qs}`)
          setDetail(r.data?.data || null)
        } else {
          setDetail(prev => prev ? {
            ...prev,
            ledger: prev.ledger.map(e => e.id === entry.id ? { ...e, ...undoPatch } : e),
          } : prev)
        }
      })
    } catch (err) {
      console.error('save edit:', err)
      alert('Failed to save: ' + (err.response?.data?.error || err.message))
    } finally {
      setEditSaving(false)
    }
  }

  // ── Split-invoice handlers ──────────────────────────────────────────────
  const openSplitModal = (entry) => {
    // Pre-fill with two rows so the affordance is "fill in song B's amount"
    // not "configure a split from scratch". The first row inherits the
    // current song so the existing spend stays attributed correctly when
    // the user hasn't yet decided which song gets the lion's share.
    // Each row carries its own artist (defaulting to the entry's) so
    // invoices covering multiple artists can be divided here without
    // needing Ledger access — same endpoint the Ledger split uses.
    setSplitModal({
      entry,
      rows: [
        { artist: entry.artist || '', song: entry.song || '', amount: '' },
        { artist: entry.artist || '', song: '', amount: '' },
      ],
    })
  }
  const updateSplitRow = (i, patch) =>
    setSplitModal(prev => prev ? {
      ...prev,
      rows: prev.rows.map((r, idx) => idx === i ? { ...r, ...patch } : r),
    } : prev)
  const addSplitRow = () =>
    setSplitModal(prev => prev ? {
      ...prev, rows: [...prev.rows, { artist: prev.entry.artist || '', song: '', amount: '' }],
    } : prev)
  const removeSplitRow = (i) =>
    setSplitModal(prev => prev && prev.rows.length > 2 ? {
      ...prev, rows: prev.rows.filter((_, idx) => idx !== i),
    } : prev)
  const saveSplit = async () => {
    if (!splitModal) return
    const { entry, rows } = splitModal
    // Validate: every row needs an artist or song plus a positive amount,
    // and the total must match the parent invoice (server doesn't enforce —
    // splits with a residual would silently misreport the row totals).
    const cleaned = rows
      .map(r => ({ artist: (r.artist || '').trim(), song: (r.song || '').trim(), amount: parseFloat(r.amount) || 0 }))
      .filter(r => (r.artist || r.song) && r.amount > 0)
    if (cleaned.length < 2) {
      alert('Add at least two rows with an artist (or song) and a positive amount.'); return
    }
    const total = cleaned.reduce((s, r) => s + r.amount, 0)
    const parentTotal = Number(entry.amount) || 0
    // 1¢ tolerance so floating-point math (e.g. $33.33 × 3 = $99.99) doesn't
    // block a split the user clearly intended to balance.
    if (Math.abs(total - parentTotal) > 0.01) {
      const ok = confirm(
        `Split total (${fmt(total, entry.currency)}) doesn't match the invoice (${fmt(parentTotal, entry.currency)}).\n\nContinue anyway?`
      )
      if (!ok) return
    }
    setSplitSaving(true)
    try {
      const artist_breakdown = cleaned.map(r => ({
        artist: r.artist || entry.artist || '',
        song: r.song,
        amount: r.amount,
      }))
      await api.post(`/bk/entries/${entry.id}/split`, { artist_breakdown })
      // Splits restructure the data (parent gets a new amount/song, children
      // get inserted). Refetch is cheaper than reconstructing locally and
      // keeps the artist_breakdown / parent_id story in lockstep with what
      // the server stored.
      const qs = showDismissed ? '?include_dismissed=true' : ''
      const r = await api.get(`/artist-campaigns/${encodeURIComponent(routeArtist)}${qs}`)
      setDetail(r.data?.data || null)
      setSplitModal(null)
      showUndo(`Split "${entry.payee || `#${entry.id}`}" into ${cleaned.length} rows`, async () => {
        // DELETE /splits is admin-gated server-side. For non-admins this
        // will 403 — the toast disappears, the row stays split, and the
        // user can re-open the split modal to fix it manually. Same
        // graceful-degrade pattern as the other undo paths.
        await api.delete(`/bk/entries/${entry.id}/splits`)
        const r2 = await api.get(`/artist-campaigns/${encodeURIComponent(routeArtist)}${qs}`)
        setDetail(r2.data?.data || null)
      })
    } catch (err) {
      console.error('split:', err)
      alert('Failed to split: ' + (err.response?.data?.error || err.message))
    } finally {
      setSplitSaving(false)
    }
  }

  // Toggle the cobrand flag on a single expense. Mirrors the
  // optimistic + undo-toast pattern. cobrand is a boolean column on
  // expenses; same source-of-truth as the Recoupments cobrand chip,
  // so a row flagged here surfaces with the cobrand tint on the
  // Recoupments page too.
  const toggleCobrand = async (entry) => {
    const current = !!entry.cobrand
    const next = !current
    // Server forces category=Marketing when cobrand flips on — mirror
    // locally, and remember the previous category so undo restores it.
    const prevCategory = entry.category
    try {
      await api.put(`/bk/entries/${entry.id}`, { cobrand: next })
      setDetail(prev => prev ? {
        ...prev,
        ledger: prev.ledger.map(e =>
          e.id === entry.id ? { ...e, cobrand: next, ...(next ? { category: 'Marketing' } : {}) } : e
        ),
      } : prev)
      showUndo(
        next
          ? `Marked "${entry.payee || `#${entry.id}`}" as cobrand`
          : `Removed cobrand on "${entry.payee || `#${entry.id}`}"`,
        async () => {
          await api.put(`/bk/entries/${entry.id}`, { cobrand: current, ...(next ? { category: prevCategory } : {}) })
          setDetail(prev => prev ? {
            ...prev,
            ledger: prev.ledger.map(e =>
              e.id === entry.id ? { ...e, cobrand: current, ...(next ? { category: prevCategory } : {}) } : e
            ),
          } : prev)
        }
      )
    } catch (err) {
      console.error('toggle cobrand:', err)
      alert('Failed to toggle cobrand: ' + (err.response?.data?.error || err.message))
    }
  }

  // Paid/Unpaid toggle — offered only on added expenses (entry_source rows
  // born on this page or Recoupments). The server stamps payment_date /
  // paid_by / paid_marked_at on the flip to Paid and clears them on the
  // flip back, so the local mirror only tracks status + date for display.
  const togglePaid = async (entry) => {
    const wasPaid = entry.payment_status === 'Paid'
    const next = wasPaid ? 'Unpaid' : 'Paid'
    const prevDate = entry.payment_date
    const localDate = next === 'Paid' ? (prevDate || new Date().toISOString().slice(0, 10)) : null
    try {
      await api.put(`/bk/entries/${entry.id}`, { payment_status: next })
      setDetail(prev => prev ? {
        ...prev,
        ledger: prev.ledger.map(e =>
          e.id === entry.id ? { ...e, payment_status: next, payment_date: localDate } : e
        ),
      } : prev)
      showUndo(
        next === 'Paid'
          ? `Marked "${entry.payee || `#${entry.id}`}" as paid`
          : `Marked "${entry.payee || `#${entry.id}`}" as unpaid`,
        async () => {
          await api.put(`/bk/entries/${entry.id}`, { payment_status: wasPaid ? 'Paid' : 'Unpaid', payment_date: prevDate })
          setDetail(prev => prev ? {
            ...prev,
            ledger: prev.ledger.map(e =>
              e.id === entry.id ? { ...e, payment_status: wasPaid ? 'Paid' : 'Unpaid', payment_date: prevDate } : e
            ),
          } : prev)
        }
      )
    } catch (err) {
      console.error('toggle paid:', err)
      alert('Failed to update payment status: ' + (err.response?.data?.error || err.message))
    }
  }

  // Bulk-deal toggle — flips expenses.is_bulk_deal, same flag the
  // Approvals pill and the Ledger's teal Bulk badge read. Quantity /
  // unit / deliverables are managed on the Bulk Deals page; this just
  // gets the row onto (or off) that page.
  const toggleBulkDeal = async (entry) => {
    const next = !entry.is_bulk_deal
    try {
      await api.put(`/bk/entries/${entry.id}`, { is_bulk_deal: next })
      setDetail(prev => prev ? {
        ...prev,
        ledger: prev.ledger.map(e =>
          e.id === entry.id ? { ...e, is_bulk_deal: next } : e
        ),
      } : prev)
      showUndo(
        next
          ? `Marked "${entry.payee || `#${entry.id}`}" as a bulk deal`
          : `Removed bulk deal on "${entry.payee || `#${entry.id}`}"`,
        async () => {
          await api.put(`/bk/entries/${entry.id}`, { is_bulk_deal: !next })
          setDetail(prev => prev ? {
            ...prev,
            ledger: prev.ledger.map(e =>
              e.id === entry.id ? { ...e, is_bulk_deal: !next } : e
            ),
          } : prev)
        }
      )
    } catch (err) {
      console.error('toggle bulk deal:', err)
      alert('Failed to toggle bulk deal: ' + (err.response?.data?.error || err.message))
    }
  }

  // ── Attach an invoice to an existing row ─────────────────────────────
  // Added expenses are born invoice-less; when the creator's real invoice
  // arrives, this uploads it onto the SAME row (same multipart endpoint
  // the Approvals attach buttons use) instead of anyone re-entering the
  // expense and creating a duplicate.
  const invoiceInputRef = useRef(null)
  const [invoiceTarget, setInvoiceTarget] = useState(null)
  const promptInvoiceUpload = (entry) => {
    setInvoiceTarget(entry)
    requestAnimationFrame(() => invoiceInputRef.current?.click())
  }
  const handleInvoiceFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    const entry = invoiceTarget
    setInvoiceTarget(null)
    if (!file || !entry) return
    try {
      const fd = new FormData()
      fd.append('file', file)
      await api.post(`/bk/entries/${entry.id}/file/invoice`, fd)
      setDetail(prev => prev ? ({
        ...prev,
        ledger: prev.ledger.map(x => x.id === entry.id ? { ...x, has_invoice: true, invoice_filename: file.name } : x),
      }) : prev)
      toast(`Invoice attached to "${entry.payee || `#${entry.id}`}"`)
    } catch (err) {
      toast.error('Upload failed: ' + (err?.response?.data?.error || err.message))
    }
  }

  const unlinkCampaign = async (campaign) => {
    try {
      const oldExpenseId = campaign.expense_id
      await api.post('/artist-campaigns/link', { campaign_id: campaign.id, expense_id: null })
      setDetail(prev => prev ? {
        ...prev,
        campaigns: prev.campaigns.map(c => c.id === campaign.id ? { ...c, expense_id: null } : c),
        ledger: prev.ledger.map(e =>
          e.id === oldExpenseId ? { ...e, campaign_id: null, campaign_name: null } : e
        ),
      } : prev)
      showUndo(`Unlinked "${campaign.name}"`, async () => {
        await api.post('/artist-campaigns/link', { campaign_id: campaign.id, expense_id: oldExpenseId })
        setDetail(prev => prev ? {
          ...prev,
          campaigns: prev.campaigns.map(c => c.id === campaign.id ? { ...c, expense_id: oldExpenseId } : c),
          ledger: prev.ledger.map(e =>
            e.id === oldExpenseId ? { ...e, campaign_id: campaign.id, campaign_name: campaign.name } : e
          ),
        } : prev)
      })
    } catch (err) {
      console.error('unlink:', err)
      alert('Failed to unlink: ' + (err.response?.data?.error || err.message))
    }
  }

  // ── Restore handler ─────────────────────────────────────────────────────
  // The Dismiss action was removed (2026-07-15) — "Not a campaign expense"
  // covers reclassification and syncs the ledger's Campaign flag, so a
  // second hide-only path just confused people. Restore stays so rows
  // dismissed before the removal can still be recovered from the
  // "Show dismissed" tray.
  const restoreEntry = async (entry) => {
    try {
      await api.post('/artist-campaigns/restore', { entry_id: entry.id })
      setDetail(prev => prev ? {
        ...prev,
        ledger: prev.ledger.map(e => e.id === entry.id ? { ...e, dismissed: false } : e),
        dismissed_count: Math.max(0, (prev.dismissed_count || 0) - 1),
      } : prev)
      showUndo(`Restored "${entry.payee || `#${entry.id}`}"`, async () => {
        await api.post('/artist-campaigns/dismiss', { entry_id: entry.id })
        setDetail(prev => prev ? {
          ...prev,
          ledger: prev.ledger.map(e => e.id === entry.id ? { ...e, dismissed: true } : e),
          dismissed_count: (prev.dismissed_count || 0) + 1,
        } : prev)
      })
    } catch (err) {
      console.error('restore:', err)
      alert('Failed to restore: ' + (err.response?.data?.error || err.message))
    }
  }

  // Delete the expense APP-WIDE — Dismiss only hides a row from this page
  // (flag_dismissals), which confused users who expected the row to leave
  // the Ledger too. This calls the same DELETE /bk/entries/:id the Ledger
  // trash can uses: the row (and any split children) disappears from the
  // Ledger, Payments, Recoupments, exports — everywhere. It's the app's
  // standard delete (soft, audit-logged), so the undo toast and the
  // admin-side Approvals Archive can still bring it back.
  const deleteEntry = async (entry) => {
    const label = entry.payee || `#${entry.id}`
    const ok = window.confirm(
      `Delete "${label}" from the ledger and every page of the app?\n\n` +
      'This removes the expense everywhere (not just this page). Any split ' +
      'children go with it. You can undo right after, and an admin can ' +
      'restore it from the archive later.'
    )
    if (!ok) return
    try {
      await api.delete(`/bk/entries/${entry.id}`)
      setDetail(prev => prev ? {
        ...prev,
        ledger: prev.ledger.filter(e => e.id !== entry.id && e.parent_id !== entry.id),
      } : prev)
      showUndo(`Deleted "${label}" from the ledger`, async () => {
        await api.post(`/bk/entries/${entry.id}/restore`)
        // Refetch — keeps song bucketing + sort order consistent with what
        // the server returns. Same pattern as the dismiss undo above.
        const qs = showDismissed ? '?include_dismissed=true' : ''
        const r = await api.get(`/artist-campaigns/${encodeURIComponent(routeArtist)}${qs}`)
        setDetail(r.data?.data || null)
      })
    } catch (err) {
      console.error('delete:', err)
      alert('Failed to delete: ' + (err.response?.data?.error || err.message))
    }
  }

  // ── "Not a campaign expense" toggle ─────────────────────────────────────
  // Segregates the row to the bottom section but keeps it visible — unlike
  // Dismiss which hides entirely. Useful for spends that belong to the
  // artist but aren't part of campaign reconciliation (e.g. admin fees,
  // legal). Single endpoint with a boolean value for both directions.
  const toggleNotCampaign = async (entry, value) => {
    try {
      await api.post('/artist-campaigns/not-campaign', { entry_id: entry.id, value })
      setDetail(prev => prev ? {
        ...prev,
        ledger: prev.ledger.map(e =>
          e.id === entry.id ? { ...e, not_campaign: value } : e
        ),
      } : prev)
      showUndo(
        value
          ? `Marked "${entry.payee || `#${entry.id}`}" as not a campaign expense`
          : `Restored "${entry.payee || `#${entry.id}`}" to campaign view`,
        async () => {
          await api.post('/artist-campaigns/not-campaign', { entry_id: entry.id, value: !value })
          setDetail(prev => prev ? {
            ...prev,
            ledger: prev.ledger.map(e =>
              e.id === entry.id ? { ...e, not_campaign: !value } : e
            ),
          } : prev)
        }
      )
    } catch (err) {
      console.error('toggle not-campaign:', err)
      alert('Failed: ' + (err.response?.data?.error || err.message))
    }
  }

  // ── Detail-view derived data ────────────────────────────────────────────
  // Rows marked "not a campaign expense" get split off into their own
  // bottom section — they shouldn't muddy the per-song campaign totals
  // (this is what makes the segregation useful vs Dismiss). They still
  // come back from the server; we just sort them client-side.
  const notCampaignEntries = useMemo(() => {
    if (!detail?.ledger) return []
    return detail.ledger.filter(e => e.not_campaign && !e.dismissed)
  }, [detail])

  // Amount sort for the spend tables. Clicking the Amount column header
  // cycles: null (default date order) → 'desc' (highest first) → 'asc' →
  // back to null. Applied WITHIN each category section so the category
  // subheaders + per-category totals stay coherent.
  const [amountSort, setAmountSort] = useState(null)

  // Build per-song buckets, separating children from parents. Parent rows
  // anchor the bucket; children render indented underneath like the Ledger.
  // Filters out not_campaign rows — they live in their own bottom section.
  const songGroups = useMemo(() => {
    if (!detail?.ledger) return []
    const buckets = {}
    // Track raw spellings per bucket so "The Jawn" (7 rows) beats
    // "The JAWN" (4 rows) as the display name — same best-spelling rule
    // artist names use across the app.
    const spellings = {} // { key: { rawName: count } }
    detail.ledger.filter(e => !e.not_campaign).forEach(e => {
      const k = songKey(e.song)
      if (!buckets[k]) buckets[k] = { key: k, song: '', entries: [], totals: {}, count: 0 }
      buckets[k].entries.push(e)
      buckets[k].count += 1
      const raw = String(e.song || '').trim()
      if (!spellings[k]) spellings[k] = {}
      // Placeholder bucket keeps its literal display; everything else
      // records the raw variant seen on this row.
      const spelling = k === SONG_UNASSIGNED ? SONG_UNASSIGNED : (raw || SONG_UNASSIGNED)
      spellings[k][spelling] = (spellings[k][spelling] || 0) + 1
    })
    Object.values(buckets).forEach(b => {
      const variants = spellings[b.key] || {}
      const best = Object.entries(variants).sort((a, b) => b[1] - a[1])[0]
      b.song = best ? best[0] : b.key
      b.totals = groupByCurrency(b.entries)
      // Song level is INVOICE-side by necessity: the cards' Settled figure comes
      // from buildPnl's bank-basis rollup, which has no song dimension at all. So
      // this says "unsettled" — invoices with no bank line behind them yet — and
      // never claims to be the same number.
      b.unsettledTotals = groupByCurrency(b.entries.filter(e => !e.bank_evidence))
      b.noBankLineCount = b.entries.filter(e =>
        !e.bank_evidence && e.payment_status === 'Paid' && e.bank_expected).length
      // Only count rows that actually need socials (Marketing / PR /
      // cobrand). A row missing socials on Recording or Distribution
      // isn't a real to-do — matches the server's missing-socials flag.
      b.missingSocials = b.entries.filter(e =>
        !e.parent_id
        && rowNeedsSocials(e)
        && socialsList(e.social_handles).length === 0
      ).length
      const unpaid = b.entries.filter(e => e.payment_status !== 'Paid')
      b.unpaidCount = unpaid.length
      b.unpaidTotals = groupByCurrency(unpaid)

      // Sort within the bucket by category (alphabetical), keeping split
      // children attached to their parent so the ↳ indent stays adjacent.
      // Parent order: category ASC (empty last), then invoice_date DESC,
      // then id DESC as a stable tiebreaker.
      const parentsById = new Map()
      const orphanChildren = []
      for (const e of b.entries) {
        if (!e.parent_id) parentsById.set(e.id, { parent: e, children: [] })
      }
      for (const e of b.entries) {
        if (!e.parent_id) continue
        const bucket = parentsById.get(e.parent_id)
        if (bucket) bucket.children.push(e)
        else orphanChildren.push(e) // parent not in this song bucket — rare
      }
      const catKey = (c) => {
        const t = String(c || '').trim().toLowerCase()
        // Push blank categories to the end regardless of direction.
        return t ? [0, t] : [1, '']
      }
      // Split families sort by their combined invoice total (parent slice
      // + children) so a big split invoice ranks by its real size.
      const famTotal = (g) =>
        (parseFloat(g.parent.amount) || 0)
        + g.children.reduce((s, c) => s + (parseFloat(c.amount) || 0), 0)
      const parentGroups = [...parentsById.values()].sort((x, y) => {
        const [xEmpty, xCat] = catKey(x.parent.category)
        const [yEmpty, yCat] = catKey(y.parent.category)
        if (xEmpty !== yEmpty) return xEmpty - yEmpty
        if (xCat !== yCat) return xCat.localeCompare(yCat)
        if (amountSort) {
          const xa = famTotal(x)
          const ya = famTotal(y)
          if (xa !== ya) return amountSort === 'asc' ? xa - ya : ya - xa
        }
        const xd = x.parent.invoice_date || ''
        const yd = y.parent.invoice_date || ''
        if (xd !== yd) return yd.localeCompare(xd)
        return (y.parent.id || 0) - (x.parent.id || 0)
      })
      const sorted = []
      for (const { parent, children } of parentGroups) {
        sorted.push(parent)
        for (const c of children) sorted.push(c)
      }
      for (const c of orphanChildren) sorted.push(c)
      b.entries = sorted
    })
    // Merge in release-derived song stubs so the artist page shows a
    // subpage card for every song the label has scheduled/released,
    // even those with zero spend on file. Keyed on the same songKey()
    // used by ledger buckets — if a release matches an existing bucket
    // (case-insensitive title), the ledger bucket wins and we skip.
    const releases = Array.isArray(detail.releases) ? detail.releases : []
    for (const r of releases) {
      const raw = String(r.project_name || '').trim()
      if (!raw) continue
      const k = songKey(raw)
      if (buckets[k]) {
        // Enrich the existing ledger-derived bucket with release meta
        // so the card can show release-date / type as extra context.
        buckets[k].release_date = buckets[k].release_date || r.release_date
        buckets[k].release_type = buckets[k].release_type || r.release_type
        buckets[k].release_id   = buckets[k].release_id   || r.id
        continue
      }
      buckets[k] = {
        key: k,
        song: raw,
        entries: [],
        totals: {},
        count: 0,
        missingSocials: 0,
        unpaidCount: 0,
        unpaidTotals: {},
        is_release_stub: true,
        release_date: r.release_date || null,
        release_type: r.release_type || null,
        release_id: r.id,
      }
    }

    return Object.values(buckets).sort((a, b) => {
      // Unassigned bucket goes last; otherwise sort by largest spend first.
      // Ties (both zero spend, e.g. two release stubs) fall back to
      // release_date DESC to put upcoming releases at the top.
      if (a.key === SONG_UNASSIGNED) return 1
      if (b.key === SONG_UNASSIGNED) return -1
      const aUsd = a.totals.USD || 0
      const bUsd = b.totals.USD || 0
      if (aUsd !== bUsd) return bUsd - aUsd
      const ad = a.release_date || ''
      const bd = b.release_date || ''
      return bd.localeCompare(ad)
    })
  }, [detail, amountSort])

  const filteredSongGroups = useMemo(() => {
    if (!isSong) return songGroups
    // Compare against the bucket key so any capitalization in the URL
    // (including old bookmarks predating the case-insensitive merge)
    // still resolves to the right group.
    const target = songKey(routeSong)
    return songGroups.filter(g => g.key === target)
  }, [songGroups, isSong, routeSong])

  // Roll-ups for the stats header. Detail view only.
  const detailStats = useMemo(() => {
    if (!detail) return null
    // Exclude dismissed AND not-a-campaign-expense rows from the stats —
    // the user has already said these aren't relevant; counting them would
    // muddy the campaign totals on the header cards.
    const active = detail.ledger.filter(e => !e.dismissed && !e.not_campaign)
    const totals = groupByCurrency(active)
    const paidTotals = groupByCurrency(active.filter(e => e.payment_status === 'Paid'))
    const unpaidTotals = groupByCurrency(active.filter(e => e.payment_status !== 'Paid'))
    const unpaidCount = active.filter(e => e.payment_status !== 'Paid').length
    const plannedUsd = detail.campaigns.reduce(
      (s, c) => s + (Number(c.total_budget) || 0), 0
    )
    const unlinkedCampaigns = detail.campaigns.filter(c => !c.expense_id).length
    // Same rule as songGroup.missingSocials — only count rows in
    // categories where socials matter (Marketing / PR / cobrand).
    const missingSocials = active.filter(e =>
      !e.parent_id
      && rowNeedsSocials(e)
      && socialsList(e.social_handles).length === 0
    ).length
    // The CAMPAIGN-scoped view, so these agree with the artist's card on the
    // index. `in_scope` comes from the server (Marketing + Advertisements today)
    // rather than a category list retyped here — the row LIST stays unscoped on
    // purpose, because this page is where you look at everything for an artist.
    // A slice of a BANK-BORN payment is settled money whose total is counted on
    // the bank side, so it must not be totalled here — the card filters it out on
    // the family root, and `family_source` is what lets this page do the same.
    // The row is still LISTED below; only the totals exclude it.
    const invoiceSide = active.filter(e => e.family_source !== 'bank_statement')
    const scoped = invoiceSide.filter(e => e.in_scope)
    const outOfScope = invoiceSide.filter(e => !e.in_scope)
    const settled = scoped.filter(e => e.bank_evidence)
    const unsettled = scoped.filter(e => !e.bank_evidence)
    return {
      totals, paidTotals, unpaidTotals, unpaidCount,
      plannedUsd, unlinkedCampaigns, missingSocials,
      campaignCount: detail.campaigns.length,
      scope: detail.scope?.categories || [],
      scopedTotals: groupByCurrency(scoped),
      settledTotals: groupByCurrency(settled),
      unsettledTotals: groupByCurrency(unsettled),
      // Paid, and a statement covering the date shows no matching line. A
      // discrepancy rather than a waiting game — same test as the cards' chip.
      noBankLineCount: unsettled.filter(e => e.payment_status === 'Paid' && e.bank_expected).length,
      outOfScopeTotals: groupByCurrency(outOfScope),
      outOfScopeCount: outOfScope.length,
    }
  }, [detail])

  // Stats + category breakdown for the song subpage. Scoped to the one
  // song bucket in filteredSongGroups. Null when not on the subpage.
  const songSubpageStats = useMemo(() => {
    if (!isSong || !filteredSongGroups.length) return null
    const group = filteredSongGroups[0]
    // Exclude split children so a $500 fee split into $300+$200 doesn't
    // double-count. Categories are read off non-child rows only.
    const nonChild = group.entries.filter(e => !e.parent_id)
    const active = nonChild.filter(e => !e.dismissed && !e.not_campaign)
    const cats = new Set(active.map(e => (e.category || '').trim()).filter(Boolean))
    return {
      totals: group.totals,
      paidTotals: groupByCurrency(group.entries.filter(e => e.payment_status === 'Paid')),
      unpaidTotals: group.unpaidTotals,
      unpaidCount: group.unpaidCount,
      missingSocials: group.missingSocials,
      categoryCount: cats.size,
      rowCount: nonChild.length,
      // Carried through from the group so the song subpage says the same thing
      // its card on the artist page does.
      unsettledTotals: group.unsettledTotals,
      noBankLineCount: group.noBankLineCount,
    }
  }, [isSong, filteredSongGroups])

  // Category breakdown — USD-equivalent per category so a mixed-currency
  // song fits on a single comparable bar. Uses fx_rate_to_usd on paid
  // rows (stamped at payment time); falls back to native amount for
  // unpaid rows (approximation — the totals card above shows exact
  // per-currency figures). Uncategorized rows roll into one bucket.
  const songCategoryBreakdown = useMemo(() => {
    if (!isSong || !filteredSongGroups.length) return []
    const group = filteredSongGroups[0]
    const byCat = new Map()
    for (const e of group.entries) {
      // Split children carry their own slices (parents keep only theirs) —
      // skipping them undercounted every split family vs the headline
      // totals. Same stale guard the cobrand summary already dropped.
      if (e.dismissed || e.not_campaign) continue
      const cat = (e.category || '').trim() || 'Uncategorized'
      const usd = entryUsd(e)
      byCat.set(cat, (byCat.get(cat) || 0) + usd)
    }
    const total = Array.from(byCat.values()).reduce((a, b) => a + b, 0)
    return Array.from(byCat.entries())
      .map(([cat, usd]) => ({ cat, usd, pct: total > 0 ? (usd / total) * 100 : 0 }))
      .sort((a, b) => b.usd - a.usd)
  }, [isSong, filteredSongGroups, entryUsd])

  // Cobrand summary — total spend on rows flagged e.cobrand=true, both
  // per-currency native totals and USD-equivalent. On the artist page
  // we also break it down by song so operators can see which songs
  // pulled the most co-brand dollars. Split children roll into their
  // parent so a co-brand invoice split N ways doesn't multi-count.
  // Rendered only when there's at least one cobrand row on the page —
  // artists with zero cobrand skip the card entirely.
  const artistCobrandSummary = useMemo(() => {
    if (isSong || !detail?.ledger) return null
    // Split CHILDREN count too: a split parent keeps only its own slice
    // (its amount is reduced when children are carved off), so counting
    // every row — parents and children alike — never double-counts. The
    // old !e.parent_id guard silently dropped cobrand split children
    // (which is most of what a multi-song cobrand invoice becomes) and
    // made the banner disagree with the rows marked below.
    const cobrand = detail.ledger.filter(e =>
      !!e.cobrand && !e.dismissed && !e.not_campaign
    )
    if (!cobrand.length) return null
    const totalsByCurrency = {}
    let usdTotal = 0
    const bySong = new Map()
    for (const e of cobrand) {
      const cur = (e.currency || 'USD').toUpperCase()
      const native = parseFloat(e.amount || 0)
      const usd = entryUsd(e)
      totalsByCurrency[cur] = (totalsByCurrency[cur] || 0) + native
      usdTotal += usd
      const songKey = (e.song || '').trim() || SONG_UNASSIGNED
      const prev = bySong.get(songKey) || { song: e.song || '(no song)', usd: 0, count: 0 }
      bySong.set(songKey, { ...prev, usd: prev.usd + usd, count: prev.count + 1 })
    }
    return {
      count: cobrand.length,
      totalsByCurrency,
      usdTotal,
      songs: Array.from(bySong.values()).sort((a, b) => b.usd - a.usd),
    }
  }, [isSong, detail?.ledger, entryUsd])

  // Song-scoped cobrand rollup. Simpler — no per-song split needed.
  // Same rule as the artist rollup: split children count (parents keep
  // only their own slice, so there's no double-count to guard against).
  const songCobrandSummary = useMemo(() => {
    if (!isSong || !filteredSongGroups.length) return null
    const cobrand = filteredSongGroups[0].entries.filter(e =>
      !!e.cobrand && !e.dismissed && !e.not_campaign
    )
    if (!cobrand.length) return null
    const totalsByCurrency = {}
    let usdTotal = 0
    for (const e of cobrand) {
      const cur = (e.currency || 'USD').toUpperCase()
      const native = parseFloat(e.amount || 0)
      totalsByCurrency[cur] = (totalsByCurrency[cur] || 0) + native
      usdTotal += entryUsd(e)
    }
    return { count: cobrand.length, totalsByCurrency, usdTotal }
  }, [isSong, filteredSongGroups, entryUsd])

  // Artist-level equivalent: sum spend by category across EVERY song of
  // this artist. Rendered as a card at the top of the artist detail
  // page so operators can eyeball total marketing / recording / PR
  // spend without having to expand every song bucket.
  const artistCategoryBreakdown = useMemo(() => {
    if (isSong || !detail?.ledger) return []
    const byCat = new Map()
    for (const e of detail.ledger) {
      // Include split children — see songCategoryBreakdown note.
      if (e.dismissed || e.not_campaign) continue
      const cat = (e.category || '').trim() || 'Uncategorized'
      const usd = entryUsd(e)
      byCat.set(cat, (byCat.get(cat) || 0) + usd)
    }
    const total = Array.from(byCat.values()).reduce((a, b) => a + b, 0)
    return Array.from(byCat.entries())
      .map(([cat, usd]) => ({ cat, usd, pct: total > 0 ? (usd / total) * 100 : 0 }))
      .sort((a, b) => b.usd - a.usd)
  }, [isSong, detail?.ledger, entryUsd])

  // For the link-campaign modal: candidate ledger entries (unlinked rows on
  // this artist; exclude split children — they can't anchor a campaign on
  // their own).
  const linkCandidates = useMemo(() => {
    if (!detail?.ledger) return []
    return detail.ledger
      .filter(e => !e.parent_id && !e.campaign_id)
      .filter(e => {
        if (!linkSearch) return true
        const q = linkSearch.toLowerCase()
        return `${e.payee || ''} ${e.song || ''} ${e.invoice_number || ''} ${e.description || ''}`
          .toLowerCase().includes(q)
      })
  }, [detail, linkSearch])

  // ── Filter index by search + sort by priority band ─────────────────────
  const filteredIndexRows = useMemo(() => {
    const PRIORITY_RANK = { high: 0, medium: 1, low: 2 }
    const metaFor = (r) => campaignMeta[(r.artist || '').toLowerCase().trim()] || {}
    let list = indexRows
    if (indexQuery) {
      const q = indexQuery.toLowerCase()
      list = list.filter(r => (r.artist || '').toLowerCase().includes(q))
    }
    // Priority band first (priority artists pin to the top), then SETTLED
    // spend highest→lowest within each band — explicit, rather than trusting
    // the server's order, which ranks on settled + committed together.
    return list.slice().sort((a, b) => {
      const ra = PRIORITY_RANK[metaFor(a).priority] ?? 99
      const rb = PRIORITY_RANK[metaFor(b).priority] ?? 99
      if (ra !== rb) return ra - rb
      // Settled first, then committed as the tiebreak: an artist with nothing
      // settled yet but real invoices outstanding should not sink to the bottom.
      const sa = Number(a.settled) || 0, sb = Number(b.settled) || 0
      if (sa !== sb) return sb - sa
      return (Number(b.committed) || 0) - (Number(a.committed) || 0)
    })
  }, [indexRows, indexQuery, campaignMeta])

  // Optimistic priority update. On failure, log + refetch so the UI
  // recovers to whatever the server actually has — the previous silent
  // catch hid PUT failures and left users thinking priorities had saved
  // when they hadn't. Hits the unified /bk/artist-meta endpoint so a
  // priority set here is identical to the one shown on Recoupments.
  const setCampaignPriority = async (artistName, value) => {
    const key = (artistName || '').toLowerCase().trim()
    setCampaignMeta(prev => ({ ...prev, [key]: { ...(prev[key] || {}), artist_key: key, priority: value } }))
    try {
      const { data } = await api.put('/bk/artist-meta', { artist: artistName, priority: value })
      // Use the server-echoed row as the source of truth — defensive
      // against any local-vs-server normalization drift.
      if (data?.data?.artist_key) {
        setCampaignMeta(prev => ({ ...prev, [data.data.artist_key]: data.data }))
      }
    } catch (err) {
      const msg = err?.response?.data?.error || err.message
      console.error('Failed to save priority:', msg)
      toast.error(`Couldn't save priority: ${msg}`)
      api.get('/bk/artist-meta').then(r => setCampaignMeta(r.data?.data || {})).catch(() => {})
    }
  }

  // Rename a song across every surface: ledger rows, release-tracker
  // rows, song_campaign_status. Server does the transactional cascade;
  // client applies the same rewrite to local state so the page reflects
  // the change without a refetch. Returns { ok, error? } so the
  // SongGroup edit UI can render an inline error on failure.
  const handleRenameSong = async (oldName, newName) => {
    const trimmed = String(newName || '').trim()
    if (!trimmed) return { ok: false, error: 'name required' }
    if (trimmed === (oldName || '').trim()) return { ok: true, changed: false }
    try {
      await api.post(
        `/artist-campaigns/${encodeURIComponent(detail?.artist || routeArtist)}/rename-song`,
        { old: oldName, new: trimmed }
      )
      const oldKey = String(oldName || '').toLowerCase().trim()
      const newKey = trimmed.toLowerCase().trim()
      setDetail(prev => prev ? {
        ...prev,
        ledger: (prev.ledger || []).map(e =>
          String(e.song || '').toLowerCase().trim() === oldKey
            ? { ...e, song: trimmed }
            : e
        ),
        releases: (prev.releases || []).map(r =>
          String(r.project_name || '').toLowerCase().trim() === oldKey
            ? { ...r, project_name: trimmed }
            : r
        ),
      } : prev)
      // Cascade song_status map so a Finished / notes flag stays with
      // the renamed song. Target-wins on collision (matches server).
      const aKey = normalizeArtistKey(detail?.artist || routeArtist)
      const oldFull = `${aKey}|${oldKey}`
      const newFull = `${aKey}|${newKey}`
      setSongStatus(prev => {
        if (!prev[oldFull]) return prev
        const { [oldFull]: moving, ...rest } = prev
        if (prev[newFull]) return rest
        return { ...rest, [newFull]: { ...moving, song_key: newKey } }
      })
      // If we're viewing the song subpage for the renamed song, hop
      // to the new URL so the page doesn't 404 into "no spend on file".
      if (isSong && oldKey === String(routeSong || '').toLowerCase().trim()) {
        navigate(`/artist-campaigns/${encodeURIComponent(detail?.artist || routeArtist)}/${encodeSongForUrl(trimmed)}`)
      }
      toast(`Renamed "${oldName}" → "${trimmed}"`)
      return { ok: true }
    } catch (err) {
      const msg = err?.response?.data?.error || err.message
      toast.error(`Couldn't rename song: ${msg}`)
      return { ok: false, error: msg }
    }
  }

  // Add-expense flow — mirrors Recoupments' modal. Opens with artist
  // and song pre-filled from the current route (no re-typing on the
  // detail page). Posts to /bk/entries directly so the row lands
  // approved + immediately visible; no vendor-approval hoop for
  // admin-added rows on this page.
  const ADD_FORM_DEFAULTS = {
    payee: '', description: '', category: 'Marketing',
    amount: '', currency: 'USD', date: '',
    notes: '', paid: true,
    // Optional socials list — starts with one empty row (default platform
    // Instagram). Only submitted when the vendor typed a handle; empty
    // rows collapse to null in the payload.
    socials: [{ platform: 'Instagram', handle: '' }],
  }
  const [addModalOpen, setAddModalOpen] = useState(false)
  const [addForm, setAddForm] = useState(ADD_FORM_DEFAULTS)
  const [addSaving, setAddSaving] = useState(false)
  const [addError, setAddError] = useState('')
  // Optional invoice file — attached to the created row via the same
  // multipart endpoint the Approvals attach buttons use. Kept out of
  // addForm since it's a File object, not form text.
  const [addFile, setAddFile] = useState(null)
  // Optional proof of payment. Uploaded through the SAME endpoint the ledger
  // and Approvals use (POST /bk/entries/:id/file/proof), which is what makes
  // the payment date fill itself in: that endpoint marks the family Paid,
  // stamps payment_date, and kicks off the background AI scan that replaces
  // the stamp with the real date read off the document. None of that is
  // reimplemented here — attaching the file is the whole feature.
  const [addProof, setAddProof] = useState(null)
  // Set once the entry row has been created. If a follow-up file upload
  // fails, clicking "Add Expense" again retries ONLY the outstanding uploads
  // instead of creating a duplicate entry.
  const [addCreatedRow, setAddCreatedRow] = useState(null)
  // Which uploads still owe the created row, so a retry can't double-post a
  // file that already landed.
  const [addPending, setAddPending] = useState({ invoice: false, proof: false })
  const openAddModal = () => {
    setAddForm({ ...ADD_FORM_DEFAULTS, date: new Date().toISOString().slice(0, 10) })
    setAddFile(null)
    setAddProof(null)
    setAddCreatedRow(null)
    setAddPending({ invoice: false, proof: false })
    setAddError('')
    setAddModalOpen(true)
  }
  const closeAddModal = () => { if (!addSaving) { setAddModalOpen(false); setAddError('') } }
  // Splice the new row into local ledger state so it appears on the page
  // without a full refetch. The song subpage will filter-match via songKey;
  // the artist page will bucket by song.
  const spliceNewRow = (row) => {
    if (!row || !detail) return
    setDetail(prev => prev ? {
      ...prev,
      ledger: [row, ...(prev.ledger || [])],
    } : prev)
  }
  // Upload whichever of {invoice, proof} is still owed. Returns what landed
  // and what didn't, so a retry re-sends only the failures — posting an
  // already-stored file again would re-trigger the proof scan and re-stamp a
  // payment date the user may have since corrected.
  const uploadAddFiles = async (rowId, want) => {
    const uploaded = [], failed = []
    for (const [type, file] of [['invoice', addFile], ['proof', addProof]]) {
      if (!want[type] || !file) continue
      try {
        const fd = new FormData()
        fd.append('file', file)
        await api.post(`/bk/entries/${rowId}/file/${type}`, fd)
        uploaded.push(type)
      } catch { failed.push(type) }
    }
    return { uploaded, failed }
  }

  // Close out a successful add. When a proof landed, the row the server now
  // holds differs from the one it returned at creation — the proof endpoint
  // marks the family Paid and stamps payment_date — so refetch rather than
  // splice a locally-guessed row. The second, delayed refetch is for the
  // background AI scan, which reads the real payment date off the document
  // and overwrites the stamp a few seconds later. Same pattern the Payments
  // page uses after a proof upload.
  const finishAdd = async (row, uploaded) => {
    const gotProof = uploaded.includes('proof')
    const refetch = async () => {
      const qs = showDismissed ? '?include_dismissed=true' : ''
      const r = await api.get(`/artist-campaigns/${encodeURIComponent(routeArtist)}${qs}`)
      setDetail(r.data?.data || null)
    }
    if (gotProof) {
      try { await refetch() } catch { spliceNewRow(row) }
      setTimeout(() => { refetch().catch(() => {}) }, 4000)
    } else {
      spliceNewRow(row && uploaded.includes('invoice')
        ? { ...row, has_invoice: true, invoice_filename: addFile?.name }
        : row)
    }
    toast(gotProof
      ? `Added "${row?.payee}" — marked paid, reading the date off the proof…`
      : `Added "${row?.payee}"`)
    setAddModalOpen(false)
    setAddForm(ADD_FORM_DEFAULTS)
    setAddFile(null)
    setAddProof(null)
    setAddCreatedRow(null)
    setAddPending({ invoice: false, proof: false })
  }

  const saveNewExpense = async () => {
    setAddError('')
    const artistName = detail?.artist || routeArtist
    if (!artistName) { setAddError('Artist context missing'); return }
    if (!addForm.payee.trim())       { setAddError('Payee is required.'); return }
    // description is optional — the payee + amount + song context are
    // enough to identify a campaign spend row.
    if (addForm.amount === '' || Number.isNaN(Number(addForm.amount))) {
      setAddError('Amount is required and must be a number.'); return
    }
    setAddSaving(true)
    // Retry path: entry already created on a prior attempt, only file
    // upload(s) failed. Skip straight to whatever is still outstanding.
    if (addCreatedRow) {
      const { failed, uploaded } = await uploadAddFiles(addCreatedRow.id, addPending)
      if (failed.length) {
        setAddPending(p => ({ invoice: p.invoice && failed.includes('invoice'), proof: p.proof && failed.includes('proof') }))
        setAddError(`${failed.join(' and ')} upload failed. The expense row was already created — click "Add Expense" to retry just the upload, or attach it later from the Ledger.`)
        setAddSaving(false)
        return
      }
      await finishAdd(addCreatedRow, uploaded)
      setAddSaving(false)
      return
    }
    try {
      const payload = {
        payee: addForm.payee.trim(),
        description: addForm.description.trim(),
        amount: Number(addForm.amount),
        currency: (addForm.currency || 'USD').toUpperCase(),
        invoice_date: addForm.date || null,
        category: addForm.category || null,
        // On the song subpage the row gets tagged with the current song
        // so it lands in the right bucket without extra editing.
        song: isSong ? (routeSong === SONG_UNASSIGNED ? null : routeSong) : null,
        notes: addForm.notes || null,
        artist: artistName,
        // Rows added via this page are campaign work by default — mark
        // artist_campaign='Yes' so the ledger's Campaign? column stays
        // consistent with where the row was created.
        artist_campaign: 'Yes',
        // Added expenses are recoupable by policy. The server defaults
        // omitted recoupable to true too — sent explicitly so the intent
        // survives either layer changing.
        recoupable: true,
        // When a proof is attached the row is created UNPAID with no date, and
        // the proof upload does the whole job: it flips the family to Paid,
        // stamps today as a fallback, and the background scan then replaces
        // that stamp with the date read off the document.
        //
        // Pre-stamping here would defeat that. The scan only overrides a
        // payment_date that is NULL or exactly today — a deliberate guard so it
        // can't clobber a date someone set by hand — so stamping the INVOICE
        // date (which "Already paid" does, and which is often backdated) would
        // make the proof's real date lose silently. Letting the pipeline own
        // the field is what makes the auto-fill actually happen.
        payment_status: addProof ? 'Unpaid' : (addForm.paid ? 'Paid' : 'Unpaid'),
        payment_date: addProof ? null : (addForm.paid ? (addForm.date || new Date().toISOString().slice(0, 10)) : null),
        // Tags this row as "born on the Artist Campaigns page" so the
        // ledger renders a distinct badge + left-border accent, even
        // when the artist_campaign flag is later toggled off.
        entry_source: 'artist_campaigns',
      }
      // Optional socials — only include rows the user actually typed
      // a handle into. Empty rows collapse to nothing so we don't
      // stamp `[]` onto the expense.
      const cleanedSocials = (addForm.socials || [])
        .map(s => ({ platform: (s.platform || '').trim(), handle: (s.handle || '').trim() }))
        .filter(s => s.handle)
      if (cleanedSocials.length) payload.social_handles = cleanedSocials
      const res = await api.post('/bk/entries', payload)
      const newRow = res.data?.data
      // Files go through the dedicated multipart endpoint — POST /bk/entries
      // is JSON-only. Same endpoint the Approvals attach buttons use.
      const want = { invoice: !!addFile, proof: !!addProof }
      if (newRow?.id && (want.invoice || want.proof)) {
        const { failed, uploaded } = await uploadAddFiles(newRow.id, want)
        if (failed.length) {
          // The row exists but is missing a file. Keep the modal open and arm
          // the retry path for ONLY what failed, so the next click can't
          // double-post a file that already landed or duplicate the row.
          setAddCreatedRow(newRow)
          setAddPending({ invoice: failed.includes('invoice'), proof: failed.includes('proof') })
          setAddError(`Expense saved, but the ${failed.join(' and ')} upload failed. Click "Add Expense" to retry just the upload.`)
          setAddSaving(false)
          return
        }
        await finishAdd(newRow, uploaded)
        return
      }
      await finishAdd(newRow, [])
    } catch (err) {
      setAddError(err?.response?.data?.error || err.message || 'Failed to save')
    } finally {
      setAddSaving(false)
    }
  }

  // Toggle the per-artist `dismissed` flag on artist_meta (shared with
  // Recoupments). Dismissed artists render in a collapsed "Dismissed"
  // section at the bottom of the index. Optimistic + refetch-on-failure
  // pattern mirrors setCampaignPriority above.
  const toggleCampaignDismissed = async (artistName, dismissed) => {
    const key = (artistName || '').toLowerCase().trim()
    setCampaignMeta(prev => ({ ...prev, [key]: { ...(prev[key] || {}), artist_key: key, dismissed } }))
    try {
      const { data } = await api.put('/bk/artist-meta', { artist: artistName, dismissed })
      if (data?.data?.artist_key) {
        setCampaignMeta(prev => ({ ...prev, [data.data.artist_key]: data.data }))
      }
    } catch (err) {
      const msg = err?.response?.data?.error || err.message
      console.error('Failed to save dismissed state:', msg)
      toast.error(`Couldn't ${dismissed ? 'dismiss' : 'restore'} artist: ${msg}`)
      api.get('/bk/artist-meta').then(r => setCampaignMeta(r.data?.data || {})).catch(() => {})
    }
  }

  // Collapse state for the Dismissed section on the index. Collapsed by
  // default so operators aren't distracted by the archive — click to
  // expand when they want to restore.
  const [dismissedCollapsed, setDismissedCollapsed] = useState(true)

  // Toggle the per-artist "campaign complete" flag on artist_meta.
  // Same optimistic + refetch-on-failure pattern as the other
  // artist_meta writes. Surfaces as a filled emerald checkmark next
  // to the artist name on the index cards + a completed strikethrough
  // treatment on the card itself. No rollup from song completions —
  // this is an explicit artist-level action.
  const toggleCampaignComplete = async (artistName, complete) => {
    const key = (artistName || '').toLowerCase().trim()
    setCampaignMeta(prev => ({
      ...prev,
      [key]: {
        ...(prev[key] || {}),
        artist_key: key,
        complete,
        complete_at: complete ? new Date().toISOString() : null,
      },
    }))
    try {
      const { data } = await api.put('/bk/artist-meta', { artist: artistName, complete })
      if (data?.data?.artist_key) {
        setCampaignMeta(prev => ({ ...prev, [data.data.artist_key]: data.data }))
      }
    } catch (err) {
      const msg = err?.response?.data?.error || err.message
      toast.error(`Couldn't ${complete ? 'mark complete' : 'reopen'}: ${msg}`)
      api.get('/bk/artist-meta').then(r => setCampaignMeta(r.data?.data || {})).catch(() => {})
    }
  }
  // Ready-for-planning marker — same artist_meta field the Recoupments
  // page toggles, so marking here surfaces there (chip + filter) and
  // vice versa.
  const setArtistReadyForPlanning = async (artistName, value) => {
    const key = (artistName || '').toLowerCase().trim()
    setCampaignMeta(prev => ({
      ...prev,
      [key]: { ...(prev[key] || {}), artist_key: key, ready_for_planning: value },
    }))
    try {
      const { data } = await api.put('/bk/artist-meta', { artist: artistName, ready_for_planning: value })
      if (data?.data?.artist_key) {
        setCampaignMeta(prev => ({ ...prev, [data.data.artist_key]: data.data }))
      }
      toast(value ? `${artistName} marked ready for recoupment planning` : `${artistName} no longer marked ready`)
    } catch (err) {
      const msg = err?.response?.data?.error || err.message
      toast.error(`Couldn't save: ${msg}`)
      api.get('/bk/artist-meta').then(r => setCampaignMeta(r.data?.data || {})).catch(() => {})
    }
  }

  // Song-level ready-for-planning — release-scoped counterpart of the
  // artist marker; stored on song_campaign_status so the Recoupments
  // song buckets see the same state.
  const setSongReadyForPlanning = async (artistName, songName, value) => {
    const key = songFinishedKey(artistName, songName)
    setSongStatus(s => ({ ...s, [key]: { ...(s[key] || {}), ready_for_planning: value } }))
    try {
      const { data } = await api.put('/bk/song-status', { artist: artistName, song: songName, ready_for_planning: value })
      if (data?.data?.artist_key && data?.data?.song_key) {
        setSongStatus(s => ({ ...s, [`${data.data.artist_key}|${data.data.song_key}`]: data.data }))
      }
      toast(value ? `"${songName}" marked ready for recoupment planning` : `"${songName}" no longer marked ready`)
    } catch (err) {
      const msg = err?.response?.data?.error || err.message
      toast.error(`Couldn't save: ${msg}`)
      api.get('/bk/song-status').then(r => setSongStatus(r.data?.data || {})).catch(() => {})
    }
  }

  const isArtistComplete = (artistName) => {
    const key = (artistName || '').toLowerCase().trim()
    return !!campaignMeta[key]?.complete
  }

  // Toggle the per-artist "flagged for review" flag on artist_meta.
  // An optional reason travels with the flag — when clearing, the
  // server drops the reason automatically. Optimistic + refetch-on-
  // failure pattern mirrors setCampaignPriority + toggleCampaignDismissed.
  const toggleCampaignFlag = async (artistName, flagged, reason = null) => {
    const key = (artistName || '').toLowerCase().trim()
    setCampaignMeta(prev => ({
      ...prev,
      [key]: {
        ...(prev[key] || {}),
        artist_key: key,
        flagged,
        flag_reason: flagged ? (reason ?? prev[key]?.flag_reason ?? null) : null,
        flagged_at: flagged ? new Date().toISOString() : null,
      },
    }))
    try {
      const body = { artist: artistName, flagged }
      if (reason != null) body.flag_reason = reason
      const { data } = await api.put('/bk/artist-meta', body)
      if (data?.data?.artist_key) {
        setCampaignMeta(prev => ({ ...prev, [data.data.artist_key]: data.data }))
      }
    } catch (err) {
      const msg = err?.response?.data?.error || err.message
      console.error('Failed to save flag state:', msg)
      toast.error(`Couldn't ${flagged ? 'flag' : 'unflag'} artist: ${msg}`)
      api.get('/bk/artist-meta').then(r => setCampaignMeta(r.data?.data || {})).catch(() => {})
    }
  }
  // Update the flag reason on an artist without changing the flag
  // state. Used by the popover's inline reason input.
  const updateArtistFlagReason = async (artistName, reason) => {
    const key = (artistName || '').toLowerCase().trim()
    setCampaignMeta(prev => ({
      ...prev,
      [key]: { ...(prev[key] || {}), artist_key: key, flag_reason: reason || null },
    }))
    try {
      await api.put('/bk/artist-meta', { artist: artistName, flag_reason: reason || '' })
    } catch (err) {
      toast.error(`Couldn't save reason: ${err?.response?.data?.error || err.message}`)
    }
  }

  // Toggle the "flagged for review" flag on a song campaign. Same
  // shape as toggleSongFinished but writes flagged/flag_reason.
  const toggleSongFlag = async (artistName, songName, flagged, reason = null) => {
    const key = songFinishedKey(artistName, songName)
    setSongStatus(s => ({
      ...s,
      [key]: {
        ...(s[key] || {}),
        artist_key: normalizeArtistKey(artistName),
        song_key: String(songName || '').toLowerCase().trim(),
        flagged,
        flag_reason: flagged ? (reason ?? s[key]?.flag_reason ?? null) : null,
        flagged_at: flagged ? new Date().toISOString() : null,
      },
    }))
    try {
      const body = { artist: artistName, song: songName, flagged }
      if (reason != null) body.flag_reason = reason
      const { data } = await api.put('/bk/song-status', body)
      if (data?.data) {
        const k = `${data.data.artist_key}|${data.data.song_key}`
        setSongStatus(s => ({ ...s, [k]: data.data }))
      }
    } catch (err) {
      toast.error(`Couldn't ${flagged ? 'flag' : 'unflag'} song: ${err?.response?.data?.error || err.message}`)
    }
  }
  const updateSongFlagReason = async (artistName, songName, reason) => {
    const key = songFinishedKey(artistName, songName)
    setSongStatus(s => ({
      ...s,
      [key]: { ...(s[key] || {}), flag_reason: reason || null },
    }))
    try {
      await api.put('/bk/song-status', { artist: artistName, song: songName, flag_reason: reason || '' })
    } catch (err) {
      toast.error(`Couldn't save reason: ${err?.response?.data?.error || err.message}`)
    }
  }

  // Per-expense flag-for-review. Writes expenses.flagged +
  // flag_reason via POST /bk/entries/:id/flag. Same optimistic
  // update pattern as the artist / song flag helpers above — the
  // local `detail.ledger` row is patched immediately, then the
  // server-echoed row overwrites on success.
  const toggleExpenseFlag = async (entryId, flagged, reason = null) => {
    setDetail(prev => prev ? ({
      ...prev,
      ledger: prev.ledger.map(e => e.id === entryId ? {
        ...e,
        flagged,
        flag_reason: flagged ? (reason ?? e.flag_reason ?? null) : null,
        flagged_at: flagged ? new Date().toISOString() : null,
      } : e),
    }) : prev)
    try {
      const body = { flagged }
      if (reason != null) body.flag_reason = reason
      const { data } = await api.post(`/bk/entries/${entryId}/flag`, body)
      if (data?.data) {
        setDetail(prev => prev ? ({
          ...prev,
          ledger: prev.ledger.map(e => e.id === entryId ? { ...e, ...data.data } : e),
        }) : prev)
      }
    } catch (err) {
      toast.error(`Couldn't ${flagged ? 'flag' : 'unflag'} expense: ${err?.response?.data?.error || err.message}`)
    }
  }
  // Per-item "done / reviewed" toggle. Independent of the song-level
  // finished flag — this is a row-by-row checklist users tick as they
  // work through a song's spend. Optimistic local flip; server-echoed
  // row overwrites on success.
  const toggleItemFinished = async (entryId, finished) => {
    setDetail(prev => prev ? ({
      ...prev,
      ledger: prev.ledger.map(e => e.id === entryId ? {
        ...e,
        item_finished: finished,
        item_finished_at: finished ? new Date().toISOString() : null,
      } : e),
    }) : prev)
    try {
      const { data } = await api.post(`/bk/entries/${entryId}/finish`, { finished })
      if (data?.data) {
        setDetail(prev => prev ? ({
          ...prev,
          ledger: prev.ledger.map(e => e.id === entryId ? { ...e, ...data.data } : e),
        }) : prev)
      }
    } catch (err) {
      toast.error(`Couldn't ${finished ? 'mark done' : 'unmark'}: ${err?.response?.data?.error || err.message}`)
    }
  }

  const updateExpenseFlagReason = async (entryId, reason) => {
    // "Save reason" without touching the flag itself. Server clears
    // reason when flagged is false, so we only send it here when the
    // row is currently flagged — otherwise it's a no-op.
    setDetail(prev => prev ? ({
      ...prev,
      ledger: prev.ledger.map(e => e.id === entryId ? { ...e, flag_reason: reason || null } : e),
    }) : prev)
    try {
      // Reuse the same endpoint by re-asserting flagged=true; that
      // updates flag_reason without flipping any other columns.
      await api.post(`/bk/entries/${entryId}/flag`, { flagged: true, flag_reason: reason || '' })
    } catch (err) {
      toast.error(`Couldn't save reason: ${err?.response?.data?.error || err.message}`)
    }
  }

  // Mirror an assignment save (AssignReviewersButton posts it) into the
  // ledger state so the chips/count update without a refetch. Same
  // review_assignments data the home-page Needs-review inbox reads.
  const updateReviewAssignees = (entryId, assignees) => {
    setDetail(prev => prev ? ({
      ...prev,
      ledger: prev.ledger.map(e => e.id === entryId ? { ...e, review_assignees: assignees } : e),
    }) : prev)
  }

  // ── Row selection + bulk apply ───────────────────────────────────────
  // Checkboxes on every spend row (select-all per song in the header)
  // feed a floating action bar that applies cobrand / bulk-deal /
  // payment state to everything selected in one go.
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const toggleSelect = (id) => setSelectedIds(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })
  const selectMany = (ids, on) => setSelectedIds(prev => {
    const next = new Set(prev)
    ids.forEach(id => on ? next.add(id) : next.delete(id))
    return next
  })
  const clearSelection = () => setSelectedIds(new Set())
  // Selection resets when navigating between artist / song pages so a
  // stale selection can't be bulk-edited invisibly from another page.
  useEffect(() => { clearSelection() }, [routeArtist, routeSong])

  const bulkApply = async (patch, localFn, label) => {
    const ids = [...selectedIds]
    if (!ids.length || bulkBusy) return
    setBulkBusy(true)
    let ok = 0, fail = 0
    for (const id of ids) {
      try { await api.put(`/bk/entries/${id}`, patch); ok++ } catch { fail++ }
    }
    setDetail(prev => prev ? ({
      ...prev,
      ledger: prev.ledger.map(e => selectedIds.has(e.id) ? { ...e, ...localFn(e) } : e),
    }) : prev)
    setBulkBusy(false)
    if (fail) toast.error(`${label}: ${ok} updated, ${fail} failed`)
    else toast(`${label} applied to ${ok} item${ok === 1 ? '' : 's'}`)
  }

  // Toggle the "finished and matched up" flag on a song campaign.
  // Optimistic + server-echoed truth pattern. Surfaces on both this
  // page (song-group header) and on the Recoupments page (song-bucket
  // header) via the shared /bk/song-status endpoint.
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
      toast(next
        ? `Marked "${songName}" finished`
        : `Reopened "${songName}"`)
    } catch (err) {
      const msg = err?.response?.data?.error || err.message
      toast.error(`Couldn't save: ${msg}`)
      // Rollback to whatever was there before (may be undefined).
      setSongStatus(s => {
        const out = { ...s }
        if (prev) out[key] = prev
        else delete out[key]
        return out
      })
    }
  }

  // Persist notes on blur. Skip when nothing changed vs. what's already
  // saved — avoids a network call for every click into the textarea.
  const saveSongNotes = async () => {
    if (!isSong || !detail?.artist) return
    const currentSaved = getSongNotes(detail.artist, routeSong)
    if (notesDraft === currentSaved) return
    const key = songFinishedKey(detail.artist, routeSong)
    const prev = songStatus[key] || null
    setNotesSaving(true)
    setSongStatus(s => ({
      ...s,
      [key]: { ...(s[key] || {}),
        artist_key: normalizeArtistKey(detail.artist),
        song_key: String(routeSong || '').toLowerCase().trim(),
        notes: notesDraft || null,
        notes_updated_at: new Date().toISOString(),
      },
    }))
    try {
      const { data } = await api.put('/bk/song-status', {
        artist: detail.artist, song: routeSong, notes: notesDraft,
      })
      if (data?.data?.artist_key && data?.data?.song_key) {
        const echoKey = `${data.data.artist_key}|${data.data.song_key}`
        setSongStatus(s => ({ ...s, [echoKey]: data.data }))
      }
      notesDirtyRef.current = false
    } catch (err) {
      toast.error(`Couldn't save notes: ${err?.response?.data?.error || err.message}`)
      setSongStatus(s => {
        const out = { ...s }
        if (prev) out[key] = prev
        else delete out[key]
        return out
      })
      setNotesDraft(prev?.notes || '')
    } finally {
      setNotesSaving(false)
    }
  }

  // Sync the notes draft when the route changes or the status map hydrates.
  // Runs only on the song subpage. The dirty ref keeps a songStatus refetch
  // (mount-time hydration, background refresh) from wiping unsaved typing —
  // notes only persist on blur, so an unconditional sync discarded whatever
  // the user typed before the fetch resolved.
  useEffect(() => { notesDirtyRef.current = false }, [routeSong, detail?.artist])
  useEffect(() => {
    if (isSong && detail?.artist && !notesDirtyRef.current) {
      setNotesDraft(getSongNotes(detail.artist, routeSong))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSong, detail?.artist, routeSong, songStatus])

  // Excel export. Server returns a .xlsx blob — trigger a browser
  // download via URL.createObjectURL. Scope narrows with the page:
  // index → every artist; artist page → that artist; song page → that
  // one release (artist + song).
  const [exporting, setExporting] = useState(false)
  const exportExcel = async (artistName, songName) => {
    if (exporting) return
    setExporting(true)
    try {
      const params = new URLSearchParams()
      if (artistName) params.set('artist', artistName)
      if (songName) params.set('song', songName)
      const qs = params.toString() ? `?${params.toString()}` : ''
      const res = await api.get(`/artist-campaigns/export${qs}`, { responseType: 'blob' })
      const blob = new Blob([res.data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const dateStamp = new Date().toISOString().slice(0, 10)
      const slugify = (s) => s.replace(/[^A-Za-z0-9._-]+/g, '_')
      const slug = [artistName && slugify(artistName), songName && slugify(songName)].filter(Boolean).join('-') || 'all'
      a.href = url
      a.download = `marketst-artist-campaigns-${slug}-${dateStamp}.xlsx`
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      const msg = err?.response?.data?.error || err.message
      toast.error(`Export failed: ${msg}`)
    } finally {
      setExporting(false)
    }
  }
  const exportButton = (artistName, songName) => (
    <button
      onClick={() => exportExcel(artistName, songName)}
      disabled={exporting}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold border transition-colors ${
        exporting
          ? 'bg-gray-50 text-gray-400 border-rule cursor-wait'
          : 'bg-card text-emerald-700 border-emerald-200 hover:bg-emerald-50 hover:border-emerald-300'
      }`}
      title={songName ? `Download "${songName}" campaign spend as .xlsx`
        : artistName ? `Download ${artistName}'s campaigns as .xlsx` : 'Download every artist as .xlsx'}
    >
      {exporting
        ? <Loader size={14} className="animate-spin" />
        : <Download size={14} />}
      {exporting ? 'Preparing…' : 'Export Excel'}
    </button>
  )

  // ── Loading shells ──────────────────────────────────────────────────────
  if (!isDetail && indexLoading) {
    return (
      <div className="space-y-4">
        <Skeleton.PageHeader />
        <Skeleton.Table rows={6} cols={4} />
      </div>
    )
  }
  if (isDetail && detailLoading) {
    return (
      <div className="space-y-4">
        <Skeleton.PageHeader />
        <Skeleton.StatCards count={4} />
        <Skeleton.Table rows={8} cols={5} />
      </div>
    )
  }

  // ── Campaign chat — one unique room per page/subpage ────────────────────
  // key={chatRoom} on the mount resets all chat state when navigating
  // between rooms, so the index / each artist / each song stay fully
  // independent chatrooms.
  const chatRoom = !isDetail
    ? 'campaigns:index'
    : isSong
      ? `campaigns:${routeArtist.trim().toLowerCase()}::${routeSong.trim().toLowerCase()}`
      : `campaigns:${routeArtist.trim().toLowerCase()}`
  const chatTitle = !isDetail ? 'Artist Campaigns' : isSong ? `${routeArtist} · ${routeSong}` : (detail?.artist || routeArtist)
  const chatEl = <CampaignChat key={chatRoom} room={chatRoom} title={chatTitle} path={chatLocation.pathname} />

  // ── INDEX VIEW ──────────────────────────────────────────────────────────
  if (!isDetail && queueView) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="Campaigns to catch up on"
          subtitle="Every song with campaign invoices that nobody has marked complete. Open one to work its invoices, or mark it complete here."
        />
        <ArtistCampaignsQueue onClose={() => navigate('/artist-campaigns')} />
      </div>
    )
  }

  if (!isDetail) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="Artist Campaigns"
          subtitle="Reconcile every artist spend on the ledger against the marketing team's tracked campaigns. Fill in missing socials inline; dismiss rows that don't relate to a campaign."
          actions={(
            <span className="flex items-center gap-2">
              {/* No count here on purpose: the queue owns that number, and a
                  second query for it on this page is how two surfaces come to
                  disagree about the same worklist. */}
              <Link to="/artist-campaigns?view=queue"
                title="Every song with campaign invoices that nobody has marked complete"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold border bg-card text-ink border-rule hover:bg-gray-50">
                <FolderOpen size={14} /> Catch up on campaigns
              </Link>
              {exportButton()}
            </span>
          )}
        />

        {/* Needs-review inbox — flagged items + open comment threads
            across every artist, with multi-user assignment. Renders
            nothing when there's no review work outstanding. */}
        <CampaignReviewInbox />
        {chatEl}

        <div className="card p-3">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={indexQuery}
              onChange={e => setIndexQuery(e.target.value)}
              placeholder="Search artists..."
              className="w-full pl-9 pr-3 py-2 text-sm rounded-lg bg-card border border-rule focus:outline-none focus:border-boom-400"
            />
          </div>
        </div>

        {/* What the page is showing, and what it is missing. Both numbers name
            their own basis: SETTLED is bank spend inside the period, COMMITTED is
            every open invoice regardless of date. Stating that beats letting one
            date control read as though it bounded both. */}
        {indexMeta && (
          <div className="card p-4 mb-4">
            <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">
                  Settled · {indexMeta.scope?.categories?.join(' + ')}
                </p>
                <p className="text-xl font-black text-gray-900 tabular-nums">
                  {fmtCompact(filteredIndexRows.reduce((t, r) => t + (Number(r.settled) || 0), 0))}
                </p>
                <p className="text-[10px] text-gray-400">
                  on statements · {indexMeta.scope?.from} → {indexMeta.scope?.to}
                </p>
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Committed</p>
                <p className="text-xl font-black text-boom-600 tabular-nums">
                  {fmtCompact(filteredIndexRows.reduce((t, r) => t + (Number(r.committed) || 0), 0))}
                </p>
                <p className="text-[10px] text-gray-400">invoices with no bank line yet · any date</p>
              </div>
              {/* The period binds Settled only. */}
              <div className="flex items-center gap-2">
                <input type="date" value={range.from} max={range.to}
                  onChange={e => setRange(r => ({ ...r, from: e.target.value }))}
                  className="border border-rule rounded-lg px-2 py-1 text-xs bg-card text-ink outline-none" />
                <span className="text-xs text-gray-400">→</span>
                <input type="date" value={range.to} min={range.from}
                  onChange={e => setRange(r => ({ ...r, to: e.target.value }))}
                  className="border border-rule rounded-lg px-2 py-1 text-xs bg-card text-ink outline-none" />
              </div>
              {indexMeta.coverage_pct != null && (
                <div className="ml-auto text-right">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Named an artist</p>
                  <p className="text-xl font-black text-gray-900 tabular-nums">{indexMeta.coverage_pct}%</p>
                  <p className="text-[10px] text-gray-400">of {fmtCompact(indexMeta.campaign_total)} campaign spend</p>
                </div>
              )}
            </div>
            {/* The gap, stated in money and rows. Every attribution moves spend
                out of this line and onto a card. */}
            {indexMeta.unattributed?.settled > 0 && (
              <div className="mt-3 pt-3 border-t border-divider flex flex-wrap items-center gap-3">
                {/* Split by category, because they are not the same problem.
                    Advertisements is ad-platform spend — Spotify, Facebook —
                    which arrives per charge and rarely names an artist on the
                    invoice; Marketing is the side where a person can usually say
                    who it was for. One combined figure hid that. */}
                {(indexMeta.scope?.categories || []).map((c) => {
                  const v = Number(indexMeta.unattributed?.by_category?.[c]) || 0
                  if (!v) return null
                  return (
                    <span key={c}
                      className="text-[11px] font-bold text-amber-700 bg-amber-50 ring-1 ring-amber-200/60 rounded px-2 py-1">
                      {fmtCompact(v)} {c.toLowerCase()} names no artist
                    </span>
                  )
                })}
                {!indexMeta.unattributed?.by_category && (
                  <span className="text-[11px] font-bold text-amber-700 bg-amber-50 ring-1 ring-amber-200/60 rounded px-2 py-1">
                    {fmtCompact(indexMeta.unattributed.settled)} of settled campaign spend names no artist
                  </span>
                )}
                <button onClick={openQueue}
                  className="text-[11px] font-bold bg-ink text-card hover:opacity-85 rounded-lg px-2.5 py-1">
                  Attribute it
                </button>
                <Link to={`/reports?tab=artists&from=${indexMeta.scope?.from}&to=${indexMeta.scope?.to}`}
                  className="text-[11px] font-bold text-gray-500 underline decoration-dotted hover:text-ink">
                  or open Spend by Artist →
                </Link>
                {indexMeta.unattributed.committed > 0 && (
                  <span className="text-[11px] text-gray-400">
                    plus {fmtCompact(indexMeta.unattributed.committed)} of committed invoices with no artist
                  </span>
                )}
                {/* Excluded by a person, not by the query — and it moves
                    Committed, so it is said out loud. */}
                {/* The ad pool: spend a rule says bills the label. Out of the
                    coverage denominator and said out loud, because a figure that
                    quietly drops $289k reads as progress. */}
                {/* Goes to /bk/advertising now, not the assign-an-amount modal.
                    That modal moved the P&L and wrote nothing to the ledger, so an
                    assignment never reached Recoupments or the artist spend sheets —
                    and in six months nobody made one ($267,674 of pool, zero
                    allocations). The new page allocates against a CAMPAIGN and
                    writes real slices. `openAdPool` is kept: it still shows any row
                    written before the change, and removing it — but only when one
                    exists, which is why the second link is conditional. On
                    production that count is zero. */}
                {indexMeta.label_level?.total > 0 && (
                  <Link to="/bk/advertising"
                    className="text-[11px] font-bold text-gray-600 bg-gray-50 ring-1 ring-rule rounded px-2 py-1 hover:text-ink hover:bg-gray-100"
                    title={`Ad-platform spend a rule says bills the LABEL, not a release — ${indexMeta.label_level.count} charges, kept out of the coverage figure because nothing on the charge names an artist. Allocate it to campaigns on Allocate Advertising.`}>
                    {fmtCompact(indexMeta.label_level.total)} ad pool, unallocated
                    {indexMeta.label_level.allocated > 0
                      ? ` · ${fmtCompact(indexMeta.label_level.allocated)} assigned` : ''}
                    {' → allocate'}
                  </Link>
                )}
                {/* The retired mechanism's own rows. `POST /reports/ad-pool` is
                    closed, but GET and DELETE stay, so anything assigned the old
                    way is still visible and still removable. No rows, no link. */}
                {indexMeta.label_level?.allocated > 0 && (
                  <button onClick={() => openAdPool()}
                    className="text-[11px] text-gray-400 underline decoration-dotted hover:text-gray-600"
                    title="Amounts assigned by the old reporting-side mechanism. Those never wrote to the ledger; open this to see or remove them.">
                    {fmtCompact(indexMeta.label_level.allocated)} assigned the old way
                  </button>
                )}
                {indexMeta.excluded?.count > 0 && (
                  <span className="text-[11px] text-gray-400"
                    title="Rows dismissed from this page or reclassified as not a campaign expense. They are in scope and open, and they are not counted in Committed.">
                    · {fmtCompact(indexMeta.excluded.total)} excluded over {indexMeta.excluded.count} rows
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {filteredIndexRows.length === 0 ? (
          <div className="card p-12 text-center">
            <p className="text-sm text-gray-400">
              {indexQuery ? `No artists match "${indexQuery}".` : 'No artist spend or campaigns on file yet.'}
            </p>
          </div>
        ) : (() => {
          // Partition rows by dismissed state. Dismissed artists render
          // in a collapsed section at the bottom so overhead / rent /
          // non-artist rows can be triaged out of the reconciliation
          // view without deleting anything. Reads campaignMeta the same
          // way the priority sort does.
          const metaFor = (r) => campaignMeta[(r.artist || '').toLowerCase().trim()] || {}
          const active    = filteredIndexRows.filter(r => !metaFor(r).dismissed)
          const dismissed = filteredIndexRows.filter(r =>  metaFor(r).dismissed)
          dismissed.sort((a, b) => (a.artist || '').localeCompare(b.artist || ''))

          const renderCard = (row, { isDismissedRow = false } = {}) => {
            const hasMismatch = row.unlinked_campaign_count > 0
            // Priority color tokens — match the Recoupments page so admins
            // get a consistent visual language across both index views.
            const PRIORITY_STYLE = {
              high:   { rail: 'border-l-rose-500',  chip: 'bg-rose-100 text-rose-700' },
              medium: { rail: 'border-l-amber-400', chip: 'bg-amber-100 text-amber-700' },
              low:    { rail: 'border-l-sky-400',   chip: 'bg-sky-100 text-sky-700' },
            }
            const meta = metaFor(row)
            const pri = meta.priority
            const priStyle = pri ? PRIORITY_STYLE[pri] : null
            // The action overlay (priority select) is rendered as a
            // SIBLING of the wrapper Link, not a descendant. Putting
            // it inside the Link triggers react-router-dom's onClick
            // before the select dropdown can open — even with
            // stopPropagation — and navigates instead of letting the
            // user pick a value. Same fix applied earlier to the
            // Recoupments index cards.
            const isComplete = isArtistComplete(row.artist)
            return (
              <div key={row.artist} className={`relative group ${isDismissedRow ? 'opacity-60' : ''} ${isComplete ? 'opacity-70' : ''}`}>
                <Link
                  to={`/artist-campaigns/${encodeURIComponent(row.artist)}`}
                  className={`card block hover:shadow-md hover:border-boom-200 transition-all p-5 pr-36 ${
                    priStyle ? `border-l-4 ${priStyle.rail}` : ''
                  } ${isComplete ? 'bg-emerald-50/30 border-emerald-100' : ''}`}
                >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 min-w-0">
                          {/* Campaign-complete checkmark — mirrors the
                              per-song completion circle on the artist
                              detail page. stopPropagation prevents the
                              wrapper <Link> from navigating when the
                              user clicks the checkbox. */}
                          <span
                            role="checkbox"
                            aria-checked={isComplete ? 'true' : 'false'}
                            tabIndex={0}
                            onClick={(e) => { e.stopPropagation(); e.preventDefault(); toggleCampaignComplete(row.artist, !isComplete) }}
                            onMouseDown={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault(); e.stopPropagation()
                                toggleCampaignComplete(row.artist, !isComplete)
                              }
                            }}
                            title={isComplete ? 'Campaign complete — click to reopen' : 'Mark campaign complete'}
                            className={`inline-flex items-center justify-center rounded-full cursor-pointer transition-colors shrink-0 ${
                              isComplete
                                ? 'text-emerald-600 hover:text-emerald-700'
                                : 'text-gray-300 hover:text-emerald-500'
                            }`}
                            style={{ width: 20, height: 20 }}
                          >
                            {isComplete
                              ? <CheckCircle2 size={18} className="fill-emerald-100" strokeWidth={2.25} />
                              : <Circle size={18} strokeWidth={2} />}
                          </span>
                          <p className={`text-sm font-bold truncate transition-colors ${isComplete ? 'text-gray-500 line-through' : 'text-gray-900 group-hover:text-boom-700'}`}>
                            {row.artist}
                          </p>
                          {(() => {
                            const explicitlyFlagged = isArtistExplicitlyFlagged(row.artist)
                            const flaggedSongs = flaggedSongCountForArtist(row.artist)
                            // Always render — FlagButton auto-fades the
                            // outlined un-flagged state to opacity-0 (visible
                            // on card hover) so it doesn't distract when
                            // nothing needs review.
                            return (
                              <FlagButton
                                flagged={explicitlyFlagged}
                                rolledUp={!explicitlyFlagged && flaggedSongs > 0}
                                rolledUpCount={flaggedSongs}
                                rolledUpLabel="song"
                                reason={getArtistFlagReason(row.artist)}
                                onToggle={(next, reason) => toggleCampaignFlag(row.artist, next, reason ?? null)}
                                onSaveReason={(reason) => updateArtistFlagReason(row.artist, reason)}
                                size="sm"
                              />
                            )
                          })()}
                        </div>
                        <p className="text-xs text-gray-400 mt-0.5">
                          {row.spend_count} spend{row.spend_count === 1 ? '' : 's'} ·{' '}
                          {row.campaign_count} campaign{row.campaign_count === 1 ? '' : 's'}
                        </p>
                        <div className="flex flex-wrap items-center gap-2 mt-2">
                          {row.unpaid_count > 0 && (
                            <span
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold text-rose-700 bg-rose-50 ring-1 ring-rose-200/60"
                              title={`${fmtCompact(row.unpaid_total)} unpaid`}
                            >
                              {row.unpaid_count} unpaid
                            </span>
                          )}
                          {row.missing_socials_count > 0 && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold text-amber-700 bg-amber-50 ring-1 ring-amber-200/60">
                              <AtSign size={9} /> {row.missing_socials_count} missing socials
                            </span>
                          )}
                          {hasMismatch && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold text-rose-700 bg-rose-50 ring-1 ring-rose-200/60">
                              <Link2 size={9} /> {row.unlinked_campaign_count} unlinked
                            </span>
                          )}
                          {!row.unpaid_count && !row.missing_socials_count && !hasMismatch && row.campaign_count > 0 && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold text-emerald-700 bg-emerald-50 ring-1 ring-emerald-200/60">
                              <CheckCircle2 size={9} /> reconciled
                            </span>
                          )}
                        </div>
                      </div>
                      {/* SETTLED first, because it is the fact: what the bank
                          paid for this artist in the period. COMMITTED is what
                          the invoices say is still coming, and it carries no
                          date bound — an unpaid invoice from last November is
                          still owed. The old pair was Actual (invoices) over
                          Planned (campaign budgets), and Planned was $0.00 on
                          every card because no campaign has ever been created. */}
                      <div className="text-right flex-shrink-0">
                        <p className="text-xs text-gray-400">Settled</p>
                        <p className="font-bold text-sm text-gray-900 tabular-nums">{fmtCompact(row.settled)}</p>
                        <p className="text-xs text-gray-400 mt-1">Committed</p>
                        <p className="font-bold text-sm text-boom-600 tabular-nums">{fmtCompact(row.committed)}</p>
                        {row.flagged_no_bank_line?.count > 0 && (
                          <p className="text-[10px] mt-1 tabular-nums text-rose-600 font-bold"
                            title={`${row.flagged_no_bank_line.count} payment${row.flagged_no_bank_line.count === 1 ? '' : 's'} marked paid where a statement covering the date shows no matching line — ${fmtCompact(row.flagged_no_bank_line.total)}. Counted in Committed, because the bank has not confirmed it.`}>
                            {row.flagged_no_bank_line.count} paid, no bank line
                          </p>
                        )}
                      </div>
                      <ChevronRight size={16} className="text-gray-300 group-hover:text-boom-500 transition-colors mt-1" />
                    </div>
                  </Link>
                  {/* Priority overlay — three discrete buttons in place
                      of a native <select>. Selects had cross-browser /
                      touch quirks that left users unable to change the
                      value. Each button stopPropagation as belt-and-
                      suspenders against the wrapping Link. */}
                  <div
                    className="absolute top-2 right-2 flex items-center gap-0.5 rounded-md bg-gray-50/80 border border-gray-200/70 p-0.5"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {[
                      { value: 'high',   label: 'H', active: 'bg-rose-100 text-rose-700',  hover: 'hover:text-rose-700' },
                      { value: 'medium', label: 'M', active: 'bg-amber-100 text-amber-700', hover: 'hover:text-amber-700' },
                      { value: 'low',    label: 'L', active: 'bg-sky-100 text-sky-700',    hover: 'hover:text-sky-700' },
                    ].map(p => {
                      const isActive = pri === p.value
                      return (
                        <button
                          key={p.value}
                          type="button"
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            setCampaignPriority(row.artist, isActive ? null : p.value)
                          }}
                          className={`text-[10px] font-bold w-5 h-5 rounded flex items-center justify-center transition-colors ${
                            isActive ? p.active : `text-gray-400 ${p.hover} hover:bg-card`
                          }`}
                          title={isActive ? `Clear ${p.value} priority` : `Set ${p.value} priority`}
                        >
                          {p.label}
                        </button>
                      )
                    })}
                    {/* Dismiss / restore — thin visual separator between
                        priority chips and the X so the two actions read
                        as distinct. Restore mode shows text since the X
                        would be misleading. */}
                    <span className="w-px h-4 bg-gray-300/70 mx-0.5" aria-hidden />
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault(); e.stopPropagation()
                        toggleCampaignDismissed(row.artist, !isDismissedRow)
                      }}
                      className={`text-[10px] font-bold rounded flex items-center justify-center transition-colors ${
                        isDismissedRow
                          ? 'px-1.5 h-5 text-emerald-600 hover:text-emerald-700 hover:bg-card'
                          : 'w-5 h-5 text-gray-400 hover:text-rose-600 hover:bg-card'
                      }`}
                      title={isDismissedRow
                        ? 'Restore this artist to the active list'
                        : 'Dismiss — moves this artist to the bottom (use for non-artist rows like rent / overhead)'}
                    >
                      {isDismissedRow ? 'Restore' : <X size={13} />}
                    </button>
                  </div>
                </div>
              )
            }

            return (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {active.map(a => renderCard(a))}
                </div>
                {dismissed.length > 0 && (
                  <div className="mt-6">
                    <button
                      type="button"
                      onClick={() => setDismissedCollapsed(v => !v)}
                      className="w-full flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-gray-400 hover:text-gray-600 px-1 py-2 border-t border-divider"
                      title={dismissedCollapsed ? 'Show dismissed artists' : 'Hide dismissed artists'}
                    >
                      {dismissedCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                      Dismissed
                      <span className="text-gray-300 font-semibold normal-case">
                        · {dismissed.length} artist{dismissed.length === 1 ? '' : 's'}
                      </span>
                    </button>
                    {!dismissedCollapsed && (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
                        {dismissed.map(a => renderCard(a, { isDismissedRow: true }))}
                      </div>
                    )}
                  </div>
                )}
              </>
            )
          })()}

        {/* ── Assigning the ad pool ───────────────────────────────────────
            The one place a person's knowledge can enter: the charges say
            SPOTIFY USA INC and nothing else, so an amount assigned here is the
            only honest way an artist gets credited for ad spend. It MOVES money
            out of the pool — the P&L never changes. */}
        {adPool && (() => {
          const d = adPool.data
          return (
            <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
              onClick={(e) => { if (e.target === e.currentTarget) setAdPool(null) }}>
              <div className="bg-card rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col">
                <div className="p-4 border-b border-divider flex items-center gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-black text-ink">Assign ad spend to artists</p>
                    <p className="text-[11px] text-gray-400">
                      Ad-platform charges name no artist, so amounts are assigned from the pool as a whole.
                      Assigning moves money out of the pool; it never changes a total.
                    </p>
                  </div>
                  <input type="month" value={adPool.month}
                    onChange={(e) => openAdPool(e.target.value)}
                    className="ml-auto border border-rule rounded-lg px-2 py-1 text-xs bg-card text-ink outline-none" />
                  <button onClick={() => setAdPool(null)} className="text-gray-400 hover:text-ink"><X size={18} /></button>
                </div>

                {adPool.loading ? (
                  <p className="p-8 text-center text-sm text-gray-400">Loading…</p>
                ) : adPool.error ? (
                  <p className="p-8 text-center text-sm text-rose-600">{adPool.error}</p>
                ) : !d ? null : (
                  <>
                    <div className="px-4 py-3 border-b border-divider flex flex-wrap items-end gap-x-8 gap-y-2 bg-gray-50/60">
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Pool · {d.month}</p>
                        <p className="text-lg font-black text-gray-900 tabular-nums">{fmtCompact(d.pool)}</p>
                      </div>
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Assigned</p>
                        <p className="text-lg font-black text-gray-900 tabular-nums">{fmtCompact(d.allocated)}</p>
                      </div>
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Left to assign</p>
                        <p className="text-lg font-black text-boom-600 tabular-nums">{fmtCompact(d.remaining)}</p>
                      </div>
                      {d.trimmed?.length > 0 && (
                        <p className="text-[10.5px] font-bold text-rose-600 max-w-xs"
                          title="An assignment the pool can no longer fund in full — a charge was recategorized or a statement re-uploaded after it was made.">
                          {d.trimmed.length} assignment{d.trimmed.length === 1 ? '' : 's'} the pool can no longer fund in full
                        </p>
                      )}
                    </div>

                    <div className="px-4 py-3 border-b border-divider flex flex-wrap items-center gap-2">
                      <ArtistSelect value={adForm.artist} options={roster}
                        onChange={(v) => setAdForm(f => ({ ...f, artist: v }))}
                        placeholder="Artist…" allowClear={false}
                        className="border border-rule rounded-lg px-2 py-1 text-[12.5px] bg-card text-ink outline-none" />
                      <span className="relative">
                        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-[12.5px]">$</span>
                        <input value={adForm.amount}
                          onChange={(e) => setAdForm(f => ({ ...f, amount: e.target.value }))}
                          placeholder="0.00" inputMode="decimal"
                          className="w-28 border border-rule rounded-lg pl-5 pr-2 py-1 text-[12.5px] bg-card text-ink outline-none tabular-nums" />
                      </span>
                      <input value={adForm.note}
                        onChange={(e) => setAdForm(f => ({ ...f, note: e.target.value }))}
                        placeholder="What it was for (optional)"
                        className="flex-1 min-w-[10rem] border border-rule rounded-lg px-2 py-1 text-[12.5px] bg-card text-ink outline-none" />
                      <button onClick={addAllocation}
                        disabled={adBusy || !adForm.artist || !(Number(String(adForm.amount).replace(/[^0-9.]/g, '')) > 0)}
                        title={`Assign this amount of the ${d.month} pool to the artist. Refused if it would exceed the ${fmtCompact(d.remaining)} left.`}
                        className="inline-flex items-center gap-1.5 bg-ink text-card hover:opacity-85 rounded-lg px-2.5 py-1 text-[12px] font-bold disabled:opacity-40">
                        {adBusy ? <Loader size={12} className="animate-spin" /> : null} Assign
                      </button>
                    </div>

                    <div className="overflow-y-auto flex-1">
                      {!d.allocations?.length ? (
                        <p className="p-8 text-center text-sm text-gray-400">
                          Nothing assigned from {d.month} yet — the whole {fmtCompact(d.pool)} is label-level.
                        </p>
                      ) : d.allocations.map((a) => (
                        <div key={a.id} className="flex items-center gap-3 px-4 py-2 border-b border-divider text-[12.5px]">
                          <span className="font-semibold text-ink truncate">{a.artist}</span>
                          <span className="text-[10px] font-bold uppercase tracking-wide text-gray-400 shrink-0">{a.category}</span>
                          {a.note ? <span className="text-gray-400 truncate">{a.note}</span> : null}
                          <span className="ml-auto font-mono font-bold shrink-0">{fmtCompact(a.amount)}</span>
                          <button onClick={() => removeAllocation(a.id)} disabled={adBusy}
                            title="Remove — the amount returns to the pool"
                            className="shrink-0 text-gray-300 hover:text-rose-600 disabled:opacity-40">
                            <X size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          )
        })()}

        {/* ── The unattributed queue ──────────────────────────────────────
            Campaign spend the statements show that names nobody. Attributing
            from here moves money out of the band above and onto a card, which
            is the point: the page closes its own gap rather than describing it.

            The write is /reports/set-artist on the row's PART ids — a payment
            split between two artists keeps its other slice. */}
        {queue && (() => {
          const rows = queue.rows || []
          const selRows = rows.filter(r => queueSel.has(r.id))
          const selTotal = selRows.reduce((t, r) => t + (Number(r.usd) || 0), 0)
          const shownTotal = rows.reduce((t, r) => t + (Number(r.usd) || 0), 0)
          const attributable = selRows.filter(r =>
            (r.part_expense_ids?.length || r.expense_id)).length
          // A label-level rule is keyed on the VENDOR, so the selection resolves
          // to its distinct payees — pick three Spotify rows and you are making
          // one rule, not three.
          const selVendors = [...new Set(selRows.map(r => String(r.payee || '').trim()).filter(Boolean))]
          return (
            <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
              onClick={(e) => { if (e.target === e.currentTarget) setQueue(null) }}>
              <div className="bg-card rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col">
                <div className="p-4 border-b border-divider flex items-center gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-black text-ink truncate">Campaign spend with no artist</p>
                    <p className="text-[11px] text-gray-400">
                      {indexMeta?.scope?.from} → {indexMeta?.scope?.to}
                      {' · '}{rows.length} row{rows.length === 1 ? '' : 's'} · {fmtCompact(shownTotal)} to attribute
                    </p>
                    {/* Named per category rather than summed, matching the band
                        this opened from and the sections below. */}
                    <p className="text-[10.5px] text-gray-400">
                      {(indexMeta?.scope?.categories || []).map((c) => {
                        const rs = rows.filter(r => r.__cat === c)
                        if (!rs.length) return null
                        return `${c} ${fmtCompact(rs.reduce((t, r) => t + (Number(r.usd) || 0), 0))} over ${rs.length}`
                      }).filter(Boolean).join('  ·  ')}
                    </p>
                    {/* Why this list is bigger than the band that opened it. */}
                    {queue.recoveries?.total > 0 && (
                      <p className="text-[10.5px] text-gray-400">
                        less {fmtCompact(queue.recoveries.total)} of reimbursements received
                        {queue.recoveries.count ? ` (${queue.recoveries.count} credit${queue.recoveries.count === 1 ? '' : 's'})` : ''}
                        {' = '}{fmtCompact(shownTotal - queue.recoveries.total)} net, the figure on the page
                      </p>
                    )}
                    {queue.truncated?.length > 0 && (
                      <p className="text-[10.5px] font-bold text-amber-700">
                        capped — {queue.truncated.join(' · ')} listed
                      </p>
                    )}
                  </div>
                  <button onClick={() => setQueue(null)}
                    className="ml-auto text-gray-400 hover:text-ink"><X size={18} /></button>
                </div>
                <div className="px-4 py-2 border-b border-divider flex flex-wrap items-center gap-2 bg-gray-50/60">
                  <label className="flex items-center gap-1.5 text-[12px] font-semibold text-gray-500 cursor-pointer">
                    <input type="checkbox"
                      checked={rows.length > 0 && queueSel.size === rows.length}
                      onChange={() => setQueueSel(queueSel.size === rows.length
                        ? new Set() : new Set(rows.map(r => r.id)))} />
                    Select all
                  </label>
                  <span className="text-[12px] text-gray-400 tabular-nums">
                    {queueSel.size} selected
                    {queueSel.size > 0 && <span className="font-bold text-gray-500"> · {fmtCompact(selTotal)}</span>}
                  </span>
                  <span className="ml-auto flex items-center gap-2">
                    <ArtistSelect value={queueArtist} options={roster} onChange={setQueueArtist}
                      placeholder="Artist…" allowClear={false}
                      className="border border-rule rounded-lg px-2 py-1 text-[12px] bg-card text-ink outline-none" />
                    {/* The other answer this queue needs. Some of these rows can
                        never name an artist — a Spotify ad account bills the
                        label — and saying so once per VENDOR clears hundreds of
                        rows that no per-row decision could. */}
                    <button onClick={markLabelLevel}
                      disabled={queueBusy || !selVendors.length}
                      title={selVendors.length
                        ? `Mark ${selVendors.length} vendor${selVendors.length === 1 ? '' : 's'} as label-level: ${selVendors.join(', ')}. Their spend leaves "names no artist" and is disclosed as the ad pool. Reversible.`
                        : 'Select rows first — the rule is made per VENDOR, from the payees you pick'}
                      className="inline-flex items-center gap-1.5 border border-rule text-gray-600 hover:text-ink rounded-lg px-2.5 py-1 text-[12px] font-bold disabled:opacity-40">
                      Not artist-level{selVendors.length ? ` (${selVendors.length})` : ''}
                    </button>
                    <button onClick={applyQueueArtist}
                      disabled={!queueArtist || queueBusy || !attributable}
                      title={attributable === selRows.length
                        ? 'Attribute the selected rows'
                        : `${attributable} of the ${selRows.length} selected rows have a ledger entry to write an artist to; the rest are unbooked bank lines.`}
                      className="inline-flex items-center gap-1.5 bg-ink text-card hover:opacity-85 rounded-lg px-2.5 py-1 text-[12px] font-bold disabled:opacity-40">
                      {queueBusy ? <Loader size={12} className="animate-spin" /> : null}
                      Attribute {attributable || ''}
                    </button>
                  </span>
                </div>
                <div className="overflow-y-auto flex-1">
                  {queue.loading ? (
                    <p className="p-8 text-center text-sm text-gray-400">Loading…</p>
                  ) : queue.error ? (
                    <p className="p-8 text-center text-sm text-rose-600">{queue.error}</p>
                  ) : rows.length === 0 ? (
                    <p className="p-8 text-center text-sm text-gray-400">
                      Every campaign payment in this period names an artist.
                    </p>
                  ) : (indexMeta?.scope?.categories || []).flatMap((cat) => {
                    // ONE SECTION PER CATEGORY. Advertisements is ad-platform
                    // spend — 30 Spotify charges in a row — and Marketing is where
                    // a person can usually name the artist. Interleaved by amount,
                    // the second was buried in the first.
                    const catRows = rows.filter(r => r.__cat === cat)
                    if (!catRows.length) return []
                    const catTotal = catRows.reduce((t, r) => t + (Number(r.usd) || 0), 0)
                    const allPicked = catRows.every(r => queueSel.has(r.id))
                    return [(
                      <div key={`h-${cat}`}
                        className="sticky top-0 z-10 flex items-center gap-2 px-4 py-1.5 bg-gray-100/95 border-b border-divider backdrop-blur">
                        <label className="flex items-center gap-1.5 cursor-pointer">
                          <input type="checkbox" checked={allPicked}
                            onChange={() => setQueueSel(prev => {
                              const next = new Set(prev)
                              catRows.forEach(r => { allPicked ? next.delete(r.id) : next.add(r.id) })
                              return next
                            })} />
                          <span className="text-[10px] font-extrabold uppercase tracking-wider text-gray-500">{cat}</span>
                        </label>
                        <span className="text-[10.5px] text-gray-400 tabular-nums">
                          {catRows.length} row{catRows.length === 1 ? '' : 's'}
                        </span>
                        <span className="ml-auto text-[11px] font-bold tabular-nums text-gray-600">
                          {fmtCompact(catTotal)}
                        </span>
                      </div>
                    ), ...catRows.map(r => (
                    <label key={r.id}
                      className="flex items-center gap-2 px-4 py-2 border-b border-divider text-[12.5px] hover:bg-gray-50/60 cursor-pointer">
                      <input type="checkbox" checked={queueSel.has(r.id)}
                        onChange={() => setQueueSel(prev => {
                          const next = new Set(prev)
                          next.has(r.id) ? next.delete(r.id) : next.add(r.id)
                          return next
                        })} />
                      <span className="font-mono text-[11px] text-gray-400 shrink-0">{String(r.date || '').slice(0, 10)}</span>
                      {/* The vendor page answers the question this row asks —
                          whose payment is this, what else did they invoice — and
                          it opens in a new tab so the selection survives. */}
                      <PayeeLink payee={r.payee} className="font-semibold text-ink truncate" />
                      {r.split_of ? (
                        <span className="text-[10px] font-bold uppercase tracking-wide text-gray-500 shrink-0"
                          title={`One part of a ${fmtCompact(r.split_of)} payment — attributing here moves only this share.`}>
                          split
                        </span>
                      ) : null}
                      {!r.part_expense_ids?.length && !r.expense_id && (
                        <span className="text-[10px] font-bold uppercase tracking-wide text-amber-700 shrink-0"
                          title="No ledger entry behind this bank line yet — book it on Bank Matching first.">
                          not booked
                        </span>
                      )}
                      <span className="ml-auto font-mono font-bold shrink-0">{fmtCompact(r.usd)}</span>
                    </label>
                  ))]
                  })}
                </div>
              </div>
            </div>
          )
        })()}
      </div>
    )
  }

  // ── DETAIL / SONG VIEW ──────────────────────────────────────────────────
  if (!detail) {
    return (
      <div className="space-y-4">
        <BackLink to="/artist-campaigns" label="All artists" />
        <PageHeader title={routeArtist} />
        <div className="card p-12 text-center">
          <p className="text-sm text-gray-400">No data for {routeArtist}.</p>
        </div>
      </div>
    )
  }

  const backTo = isSong
    ? `/artist-campaigns/${encodeURIComponent(routeArtist)}`
    : '/artist-campaigns'
  const backLabel = isSong ? `Back to ${detail.artist}` : 'All artists'

  return (
    <div className="space-y-4">
      {chatEl}
      {/* Hidden picker for attaching an invoice to an existing row —
          triggered by the row strip's no-invoice upload chip. */}
      <input
        ref={invoiceInputRef}
        type="file"
        accept=".pdf,.png,.jpg,.jpeg,.gif,.webp"
        onChange={handleInvoiceFile}
        className="hidden"
      />
      {/* Floating bulk-action bar — appears whenever rows are selected
          via the new checkboxes. Applies the toggle to every selected
          row (server mirrors cobrand→Marketing; local state follows). */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 flex-wrap px-4 py-2.5 rounded-full bg-gray-900 text-white shadow-xl">
          <span className="text-xs font-bold whitespace-nowrap">{selectedIds.size} selected</span>
          <span className="w-px h-4 bg-white/20" />
          <button disabled={bulkBusy} onClick={() => bulkApply({ cobrand: true }, () => ({ cobrand: true, category: 'Marketing' }), 'Cobrand')}
            className="px-2.5 py-1 rounded-full text-[11px] font-bold bg-white/10 hover:bg-white/20 disabled:opacity-40">
            Cobrand
          </button>
          <button disabled={bulkBusy} onClick={() => bulkApply({ cobrand: false }, () => ({ cobrand: false }), 'Cobrand removed')}
            className="px-2.5 py-1 rounded-full text-[11px] font-bold bg-white/10 hover:bg-white/20 disabled:opacity-40">
            Un-cobrand
          </button>
          <button disabled={bulkBusy} onClick={() => bulkApply({ is_bulk_deal: true }, () => ({ is_bulk_deal: true }), 'Bulk deal')}
            className="px-2.5 py-1 rounded-full text-[11px] font-bold bg-white/10 hover:bg-white/20 disabled:opacity-40">
            Bulk deal
          </button>
          <button disabled={bulkBusy} onClick={() => bulkApply({ payment_status: 'Paid' }, (e) => ({ payment_status: 'Paid', payment_date: e.payment_date || new Date().toISOString().slice(0, 10) }), 'Marked paid')}
            className="px-2.5 py-1 rounded-full text-[11px] font-bold bg-white/10 hover:bg-white/20 disabled:opacity-40">
            Mark paid
          </button>
          <button disabled={bulkBusy} onClick={() => bulkApply({ payment_status: 'Unpaid' }, () => ({ payment_status: 'Unpaid', payment_date: null }), 'Marked unpaid')}
            className="px-2.5 py-1 rounded-full text-[11px] font-bold bg-white/10 hover:bg-white/20 disabled:opacity-40">
            Mark unpaid
          </button>
          <span className="w-px h-4 bg-white/20" />
          <button onClick={clearSelection} className="px-2 py-1 rounded-full text-[11px] font-semibold text-white/60 hover:text-white" title="Clear selection">
            <X size={13} />
          </button>
        </div>
      )}
      <BackLink to={backTo} label={backLabel} />
      {isSong && (
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <Link to="/artist-campaigns" className="hover:text-boom-600">Artist Campaigns</Link>
          <ChevronRight size={10} />
          <Link to={`/artist-campaigns/${encodeURIComponent(routeArtist)}`} className="hover:text-boom-600">
            {routeArtist}
          </Link>
          <ChevronRight size={10} />
          <span className="text-gray-600 font-semibold">{routeSong}</span>
        </div>
      )}
      <PageHeader
        title={isSong ? routeSong : detail.artist}
        subtitle={isSong
          ? `${detail.artist} — song-level reconciliation`
          : 'Reconcile artist spend against the marketing team\'s campaign records.'}
        // Export scoped to this artist on the detail page. On the song
        // subpage we skip the export button — the artist-scoped
        // workbook covers the song anyway, and a song-only export
        // would be a lot of chrome for one section. Add-expense
        // renders on both artist + song pages, pre-filling context
        // from the current route.
        actions={
          <div className="flex items-center gap-2">
            {/* Ready-for-planning toggle — writes the same artist_meta
                marker the Recoupments cards show and filter on. */}
            {!isSong && (() => {
              const ready = !!campaignMeta[(detail.artist || routeArtist).toLowerCase().trim()]?.ready_for_planning
              return (
                <button
                  onClick={() => setArtistReadyForPlanning(detail.artist || routeArtist, !ready)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold border transition-colors ${
                    ready
                      ? 'bg-sky-50 text-sky-700 border-sky-300 hover:bg-sky-100'
                      : 'bg-card text-gray-500 border-rule hover:text-sky-700 hover:border-sky-300 hover:bg-sky-50'
                  }`}
                  title={ready
                    ? 'Marked ready for recoupment planning — click to unmark'
                    : 'Mark this artist as ready for recoupment planning (shows on the Recoupments page)'}
                >
                  <FolderOpen size={14} /> {ready ? 'Ready for planning ✓' : 'Ready for planning'}
                </button>
              )
            })()}
            {/* Song subpage gets the release-scoped marker — same visual,
                stored on song_campaign_status. */}
            {isSong && (() => {
              const ready = !!songStatus[songFinishedKey(detail?.artist || routeArtist, routeSong)]?.ready_for_planning
              return (
                <button
                  onClick={() => setSongReadyForPlanning(detail?.artist || routeArtist, routeSong, !ready)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold border transition-colors ${
                    ready
                      ? 'bg-sky-50 text-sky-700 border-sky-300 hover:bg-sky-100'
                      : 'bg-card text-gray-500 border-rule hover:text-sky-700 hover:border-sky-300 hover:bg-sky-50'
                  }`}
                  title={ready
                    ? 'This release is marked ready for recoupment planning — click to unmark'
                    : 'Mark this release as ready for recoupment planning (shows on the Recoupments page)'}
                >
                  <FolderOpen size={14} /> {ready ? 'Ready for planning ✓' : 'Ready for planning'}
                </button>
              )
            })()}
            <button
              onClick={openAddModal}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold border bg-card text-boom-700 border-boom-200 hover:bg-boom-50 hover:border-boom-300"
              title={isSong
                ? `Add an expense pinned to "${routeSong}"`
                : `Add an expense for ${detail.artist}`}
            >
              <Plus size={14} /> Add Expense
            </button>
            {isSong ? exportButton(detail.artist || routeArtist, routeSong) : exportButton(detail.artist)}
          </div>
        }
      />

      {/* Song subpage: stat cards + category breakdown + notes. Rendered
          above the "Spend on this song" ledger so the reconciler sees
          the summary first, then dives into the rows. */}
      {isSong && songSubpageStats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            label="Actual spend"
            value={fmtTotals(songSubpageStats.totals)}
            tone="default"
            sub={songSubpageStats.unpaidCount > 0
              ? `${fmtTotals(songSubpageStats.paidTotals)} paid · ${fmtTotals(songSubpageStats.unpaidTotals)} unpaid`
              : 'all paid'}
          />
          <StatCard
            label="Unsettled"
            value={fmtTotals(songSubpageStats.unsettledTotals || {})}
            tone={songSubpageStats.noBankLineCount > 0 ? 'rose' : 'default'}
            sub={songSubpageStats.noBankLineCount > 0
              ? `${songSubpageStats.noBankLineCount} paid with no bank line`
              : `${songSubpageStats.rowCount} row${songSubpageStats.rowCount === 1 ? '' : 's'} · ${songSubpageStats.categoryCount} categor${songSubpageStats.categoryCount === 1 ? 'y' : 'ies'}`}
          />
          <StatCard
            label="Missing socials"
            value={songSubpageStats.missingSocials}
            tone={songSubpageStats.missingSocials > 0 ? 'amber' : 'green'}
            sub={songSubpageStats.missingSocials === 0 ? 'all rows have handles' : 'add inline below'}
          />
          <StatCard
            label="Status"
            value={isSongFinished(detail?.artist || routeArtist, routeSong) ? 'Complete' : 'In progress'}
            tone={isSongFinished(detail?.artist || routeArtist, routeSong) ? 'green' : 'default'}
            sub={isSongFinished(detail?.artist || routeArtist, routeSong)
              ? 'marked finished + reconciled'
              : 'click ○ next to song title to mark done'}
          />
        </div>
      )}

      {/* Cobrand rollup for the song subpage — total co-brand spend
          across this song, rendered as a compact banner card. Skipped
          when nothing is flagged cobrand on this song. */}
      {isSong && songCobrandSummary && (
        <div className="card p-4 border-l-4 border-l-blue-400 bg-blue-50/30">
          <div className="flex items-baseline gap-3 flex-wrap">
            <h3 className="text-xs font-bold text-blue-800 uppercase tracking-wider inline-flex items-center gap-1.5">
              <Sparkles size={12} className="text-blue-600" /> Cobrand on this song
            </h3>
            <span className="text-lg font-bold text-gray-900 tabular-nums">
              {fmtTotals(songCobrandSummary.totalsByCurrency)}
            </span>
            <span className="text-xs text-gray-500">
              {songCobrandSummary.count} row{songCobrandSummary.count === 1 ? '' : 's'}
              {Object.keys(songCobrandSummary.totalsByCurrency).length > 1
                && ` · ≈ ${fmtCompact(songCobrandSummary.usdTotal)} USD`}
            </span>
          </div>
        </div>
      )}

      {/* Category breakdown — USD-equivalent bars per category. Only
          rendered when there's spend on file. */}
      {isSong && songCategoryBreakdown.length > 0 && (
        <div className="card p-4">
          <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">
            Spend by category
          </h3>
          <div className="space-y-2">
            {songCategoryBreakdown.map(row => (
              <div key={row.cat} className="flex items-center gap-3 text-xs">
                <span className="w-32 shrink-0 font-semibold text-gray-700 truncate" title={row.cat}>
                  {row.cat}
                </span>
                <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-boom-500 rounded-full transition-all"
                    style={{ width: `${Math.max(row.pct, 2)}%` }}
                  />
                </div>
                <span className="w-24 text-right font-bold tabular-nums text-gray-900">
                  {fmtCompact(row.usd)}
                </span>
                <span className="w-12 text-right tabular-nums text-gray-400">
                  {row.pct.toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-gray-400 mt-3">
            USD-equivalent — locked rates on paid rows, native amount on unpaid rows.
          </p>
        </div>
      )}

      {/* Notes — freeform per-song campaign notes. Saves on blur. */}
      {isSong && (
        <div className="card p-4">
          <div className="flex items-center gap-2 mb-2">
            <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider">
              Notes
            </h3>
            {notesSaving && <span className="text-[10px] text-gray-400 italic">saving…</span>}
            {!notesSaving && songStatus[songFinishedKey(detail?.artist || routeArtist, routeSong)]?.notes_updated_at && (
              <span className="text-[10px] text-gray-400">
                last updated {new Date(songStatus[songFinishedKey(detail?.artist || routeArtist, routeSong)].notes_updated_at).toLocaleDateString()}
                {songStatus[songFinishedKey(detail?.artist || routeArtist, routeSong)].notes_updated_by_name
                  ? ` by ${songStatus[songFinishedKey(detail?.artist || routeArtist, routeSong)].notes_updated_by_name}`
                  : ''}
              </span>
            )}
          </div>
          <textarea
            value={notesDraft}
            onChange={e => { notesDirtyRef.current = true; setNotesDraft(e.target.value.slice(0, 4000)) }}
            onBlur={saveSongNotes}
            placeholder="Context for this campaign — deliverables, socials to chase, blockers, marketing team decisions, anything the next person opening this page should know."
            rows={4}
            className="w-full text-sm rounded border border-rule bg-transparent px-3 py-2 focus:outline-none focus:ring-2 focus:ring-boom-500/40 resize-y"
            style={{ fontFamily: 'inherit', lineHeight: 1.5 }}
          />
          <div className="text-[10px] text-gray-400 text-right mt-1">
            {notesDraft.length}/4000 · saves on blur
          </div>
        </div>
      )}

      {/* Song discussion thread — sits right below the notes so the
          free-form context (notes) and the back-and-forth (comments)
          live together. Separate room namespace from the slide-over
          chat so the two conversations don't interleave. */}
      {isSong && (
        <RoomCommentThread
          key={`notes-${chatRoom}`}
          room={`campaigns-notes:${routeArtist.trim().toLowerCase()}::${routeSong.trim().toLowerCase()}`}
          title={`${detail?.artist || routeArtist} · ${routeSong}`}
          path={chatLocation.pathname}
        />
      )}

      {/* Stats — artist view only. The song subpage shows a narrower header. */}
      {!isSong && detailStats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {/* Campaign spend, on the same scope the artist's CARD counts, so the
              two agree. "Invoiced" and not "Settled": the card's Settled figure
              is bank-basis from buildPnl and this one is the sum of invoices —
              two different questions about the same artist. Rows outside the
              scope are still LISTED below, just not totalled here. */}
          <StatCard
            label={`Invoiced · ${detailStats.scope.join(' + ') || 'campaigns'}`}
            value={fmtTotals(detailStats.scopedTotals)}
            tone="default"
            sub={detailStats.outOfScopeCount > 0
              ? `plus ${fmtTotals(detailStats.outOfScopeTotals)} outside campaigns, listed below`
              : detailStats.unpaidCount > 0
                ? `${fmtTotals(detailStats.paidTotals)} paid · ${fmtTotals(detailStats.unpaidTotals)} unpaid`
                : 'all paid'}
          />
          <StatCard
            label="Unsettled"
            value={fmtTotals(detailStats.unsettledTotals)}
            tone={detailStats.noBankLineCount > 0 ? 'rose' : 'default'}
            sub={detailStats.noBankLineCount > 0
              ? `${detailStats.noBankLineCount} paid with no bank line`
              : 'no bank line behind it yet'}
          />
          <StatCard
            label="Missing socials"
            value={detailStats.missingSocials}
            tone={detailStats.missingSocials > 0 ? 'amber' : 'green'}
            sub={detailStats.missingSocials === 0 ? 'all rows have handles' : 'inline + add below'}
          />
          <StatCard
            label="Unlinked campaigns"
            value={detailStats.unlinkedCampaigns}
            tone={detailStats.unlinkedCampaigns > 0 ? 'rose' : 'green'}
            sub={detailStats.unlinkedCampaigns === 0 ? 'all campaigns matched' : 'pick a ledger row →'}
          />
        </div>
      )}

      {/* Artist discussion thread — page-scoped comments for this artist,
          same treatment the song subpage gets below its notes. */}
      {!isSong && (
        <RoomCommentThread
          key={`notes-${chatRoom}`}
          room={`campaigns-notes:${routeArtist.trim().toLowerCase()}`}
          title={detail?.artist || routeArtist}
          path={chatLocation.pathname}
        />
      )}

      {/* Cobrand summary for the artist page — headline total plus a
          per-song breakdown so operators can see which songs pulled
          the most co-brand dollars. Only rendered when there's at
          least one cobrand row on file for this artist. */}
      {!isSong && artistCobrandSummary && (
        <div className="card p-4 border-l-4 border-l-blue-400 bg-blue-50/30">
          <div className="flex items-baseline gap-3 flex-wrap">
            <h3 className="text-xs font-bold text-blue-800 uppercase tracking-wider inline-flex items-center gap-1.5">
              <Sparkles size={12} className="text-blue-600" /> Cobrand spend
            </h3>
            <span className="text-lg font-bold text-gray-900 tabular-nums">
              {fmtTotals(artistCobrandSummary.totalsByCurrency)}
            </span>
            <span className="text-xs text-gray-500">
              {artistCobrandSummary.count} row{artistCobrandSummary.count === 1 ? '' : 's'} · {artistCobrandSummary.songs.length} song{artistCobrandSummary.songs.length === 1 ? '' : 's'}
              {Object.keys(artistCobrandSummary.totalsByCurrency).length > 1
                && ` · ≈ ${fmtCompact(artistCobrandSummary.usdTotal)} USD`}
            </span>
          </div>
          {artistCobrandSummary.songs.length > 1 && (
            <div className="mt-3 pt-3 border-t border-blue-100 space-y-1.5">
              {artistCobrandSummary.songs.slice(0, 6).map(s => (
                <div key={s.song} className="flex items-center gap-3 text-xs">
                  <span className="flex-1 min-w-0 font-semibold text-gray-700 truncate" title={s.song}>
                    {s.song}
                  </span>
                  <span className="text-gray-400 tabular-nums">
                    {s.count} row{s.count === 1 ? '' : 's'}
                  </span>
                  <span className="w-24 text-right font-bold tabular-nums text-gray-900">
                    {fmtCompact(s.usd)}
                  </span>
                </div>
              ))}
              {artistCobrandSummary.songs.length > 6 && (
                <div className="text-[10px] text-gray-400 pt-1">
                  + {artistCobrandSummary.songs.length - 6} more song{artistCobrandSummary.songs.length - 6 === 1 ? '' : 's'}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Artist-level category breakdown — mirrors the song subpage's
          per-category bars but rolls up every song of this artist so
          operators can eyeball total marketing / PR / recording spend
          without expanding buckets. USD-equivalent per row; totals-card
          above still shows per-currency native amounts. */}
      {!isSong && artistCategoryBreakdown.length > 0 && (
        <div className="card p-4">
          <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">
            Spend by category
          </h3>
          <div className="space-y-2">
            {artistCategoryBreakdown.map(row => (
              <div key={row.cat} className="flex items-center gap-3 text-xs">
                <span className="w-32 shrink-0 font-semibold text-gray-700 truncate" title={row.cat}>
                  {row.cat}
                </span>
                <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-boom-500 rounded-full transition-all"
                    style={{ width: `${Math.max(row.pct, 2)}%` }}
                  />
                </div>
                <span className="w-24 text-right font-bold tabular-nums text-gray-900">
                  {fmtCompact(row.usd)}
                </span>
                <span className="w-12 text-right tabular-nums text-gray-400">
                  {row.pct.toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-gray-400 mt-3">
            USD-equivalent across every song — locked rates on paid rows, native amount on unpaid rows.
          </p>
        </div>
      )}

      {/* Campaigns section — surfaces the marketing team's records first so
          the reconciliation work (link / unlink) is one click away. Hidden
          on the song subpage since campaigns aren't song-scoped. */}
      {!isSong && detail.campaigns.length > 0 && (
        <CampaignsTable
          campaigns={detail.campaigns}
          ledger={detail.ledger}
          onLink={openLinkModal}
          onUnlink={unlinkCampaign}
        />
      )}

      {/* Songs section — ledger rows grouped by song. Each group expandable. */}
      <div className="space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="text-sm font-bold text-gray-700 flex items-center gap-2">
            <Music2 size={14} className="text-boom-500" />
            {isSong ? 'Spend on this song' : 'Spend by song'}
          </h3>
          {/* Show-dismissed toggle. Hidden when there's nothing to surface
              so the affordance only appears once the page actually has
              dismissed rows to manage. */}
          {!isSong && (detail.dismissed_count > 0 || showDismissed) && (
            <button
              onClick={() => setShowDismissed(v => !v)}
              className={`ml-auto inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-semibold transition-colors ${
                showDismissed
                  ? 'text-boom-700 bg-boom-50 ring-1 ring-boom-200/60'
                  : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50 ring-1 ring-rule'
              }`}
              title={showDismissed ? 'Hide dismissed rows' : 'Show dismissed rows'}
            >
              {showDismissed ? <Eye size={11} /> : <EyeOff size={11} />}
              {showDismissed
                ? `Hide dismissed (${detail.dismissed_count})`
                : `Show dismissed (${detail.dismissed_count})`}
            </button>
          )}
        </div>
        {(() => {
          // On the artist page, split into songs-with-spend and
          // release-stubs (no spend yet). Stubs get their own section
          // below so they don't clutter the reconciliation work above.
          // On the song subpage there's only one group anyway, so the
          // partition collapses to a single list.
          const withSpend = isSong
            ? filteredSongGroups
            : filteredSongGroups.filter(g => (g.count || 0) > 0)
          if (filteredSongGroups.length === 0) {
            return (
              <div className="card p-8 text-center">
                <p className="text-sm text-gray-400">No spend on file{isSong ? ` for "${routeSong}"` : ''}.</p>
              </div>
            )
          }
          if (withSpend.length === 0) {
            return (
              <div className="card p-6 text-center">
                <p className="text-sm text-gray-400">No spend on file yet. Scheduled / released songs appear below.</p>
              </div>
            )
          }
          return withSpend.map(group => (
            <SongGroup
              key={group.key}
              group={group}
              collapsed={collapsedSongs.has(group.key) && !isSong}
              onToggle={() => toggleSong(group.key)}
              onOpenSocials={openSocialsEditor}
              onOpenEdit={openEditModal}
              onOpenSplit={openSplitModal}
              onToggleCobrand={toggleCobrand}
              onToggleBulkDeal={toggleBulkDeal}
              onTogglePaid={togglePaid}
              onMarkNotCampaign={(e) => toggleNotCampaign(e, true)}
              finished={isSongFinished(detail?.artist || routeArtist, group.song)}
              onToggleFinished={() => toggleSongFinished(detail?.artist || routeArtist, group.song,
                isSongFinished(detail?.artist || routeArtist, group.song))}
              flagged={isSongFlagged(detail?.artist || routeArtist, group.song)}
              flagReason={getSongFlagReason(detail?.artist || routeArtist, group.song)}
              onToggleFlag={(next, reason) => toggleSongFlag(detail?.artist || routeArtist, group.song, next, reason)}
              onSaveFlagReason={(reason) => updateSongFlagReason(detail?.artist || routeArtist, group.song, reason)}
              onToggleExpenseFlag={toggleExpenseFlag}
              onSaveExpenseFlagReason={updateExpenseFlagReason}
              onAssignReviewers={updateReviewAssignees}
              selectedIds={selectedIds}
              onToggleSelect={toggleSelect}
              onSelectMany={selectMany}
              onToggleItemFinished={toggleItemFinished}
              onRestore={restoreEntry}
              onDelete={deleteEntry}
              currentUser={currentUser}
              amountSort={amountSort}
              onToggleAmountSort={() => setAmountSort(s => s === 'desc' ? 'asc' : s === 'asc' ? null : 'desc')}
              onPreviewInvoice={(entry) => setPreviewFile({
                url: invoiceUrl(entry),
                filename: `Invoice-${entry.payee || entry.id}`,
              })}
              hasInvoiceFile={hasInvoiceFile}
              onUploadInvoice={promptInvoiceUpload}
              onOpenSong={(songName) =>
                navigate(`/artist-campaigns/${encodeURIComponent(routeArtist)}/${encodeSongForUrl(songName)}`)
              }
              hideOpenSong={isSong}
              onRenameSong={handleRenameSong}
              // Artist page: click-through card only, no inline accordion.
              // Song subpage: detail mode — expanded ledger table.
              linkMode={!isSong}
            />
          ))
        })()}
      </div>

      {/* Release-stub section — songs pulled from the Release Tracker
          that don't have any spend on the ledger yet. Kept below the
          reconciliation work so the empty rows don't compete with
          spend-backed songs. Collapsed by default when there are more
          than a handful. Song subpage skips this entirely. */}
      {!isSong && (() => {
        const stubs = filteredSongGroups.filter(g => (g.count || 0) === 0)
        if (!stubs.length) return null
        return (
          <ReleaseStubsSection
            stubs={stubs}
            onOpenSong={(songName) =>
              navigate(`/artist-campaigns/${encodeURIComponent(routeArtist)}/${encodeSongForUrl(songName)}`)
            }
          />
        )
      })()}

      {/* ── "Not a campaign expense" section ────────────────────────────
          Anchor at the bottom of the page so the segregation is visible
          but doesn't compete with the campaign reconciliation work above.
          Hidden on the song-subpage view to keep that view focused on one
          song's spends. */}
      {!isSong && ['Admin', 'Superadmin', 'Approver'].includes(currentUser?.role) && notCampaignEntries.length > 0 && (
        <NotCampaignSection
          entries={notCampaignEntries}
          onRestore={(e) => toggleNotCampaign(e, false)}
          onPreviewInvoice={(entry) => setPreviewFile({
            url: invoiceUrl(entry),
            filename: `Invoice-${entry.payee || entry.id}`,
          })}
          hasInvoiceFile={hasInvoiceFile}
        />
      )}

      {/* ── Socials editor (centered modal) ─────────────────────────────── */}
      {socialsModal && (
        <Modal onClose={() => setSocialsModal(null)} title="Edit socials">
          <div className="space-y-2">
            {socialsRows.map((row, i) => (
              <div key={i} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <select
                    value={row.platform || 'Instagram'}
                    onChange={e => setSocialsRows(rs => rs.map((r, idx) => idx === i ? { ...r, platform: e.target.value } : r))}
                    className="rounded-lg border border-rule px-2 py-1.5 text-xs bg-card"
                  >
                    {SOCIAL_PLATFORMS.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                  <input
                    type="text"
                    value={row.handle || ''}
                    onChange={e => setSocialsRows(rs => rs.map((r, idx) => idx === i ? { ...r, handle: e.target.value } : r))}
                    placeholder="@handle or url"
                    className="flex-1 rounded-lg border border-rule px-2 py-1.5 text-xs bg-card"
                  />
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={row.amount || ''}
                    onChange={e => setSocialsRows(rs => rs.map((r, idx) => idx === i ? { ...r, amount: e.target.value } : r))}
                    placeholder="$"
                    title="Amount paid to this creator (optional)"
                    className="w-20 rounded-lg border border-rule px-2 py-1.5 text-xs bg-card"
                  />
                  <button
                    onClick={() => setSocialsRows(rs => rs.filter((_, idx) => idx !== i))}
                    className="text-gray-400 hover:text-rose-500"
                    title="Remove"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                {/* Per-row artist tag — only on split invoices (>1
                    artist in the family). Empty = shared across every
                    artist on this invoice. */}
                {(socialsModal?.familyArtists || []).length > 1 && (
                  <div className="flex items-center gap-2 pl-1">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500 shrink-0" style={{ minWidth: 62 }}>For artist</span>
                    <select
                      value={row.artist || ''}
                      onChange={e => setSocialsRows(rs => rs.map((r, idx) => idx === i ? { ...r, artist: e.target.value } : r))}
                      className="flex-1 rounded-lg border border-rule px-2 py-1.5 text-xs bg-card"
                    >
                      <option value="">All artists (untagged)</option>
                      {(socialsModal.familyArtists || []).map(a => <option key={a} value={a}>{a}</option>)}
                    </select>
                  </div>
                )}
              </div>
            ))}
            <button
              disabled={false}
              onClick={() => setSocialsRows(rs => [...rs, { platform: 'Instagram', handle: '', artist: socialsModal?.defaultArtist || '', amount: '' }])}
              className="text-xs text-boom-600 hover:text-boom-700 font-semibold inline-flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Plus size={11} /> Add another
            </button>
          </div>
          {/* Running total of the per-creator amounts vs the invoice —
              emerald when they balance, amber when off, plain when the
              target row isn't on this page (retargeted parent). */}
          {(() => {
            const sum = socialsRows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0)
            if (!(sum > 0)) return null
            const target = (detail?.ledger || []).find(en => en.id === socialsModal.entryId)
            const cur = target?.currency || 'USD'
            const invoiceAmt = target != null ? Number(target.amount) : null
            const balanced = invoiceAmt != null && Math.abs(sum - invoiceAmt) < 0.01
            return (
              <div className={`text-xs rounded-lg px-3 py-2 mt-3 flex items-center justify-between ${
                invoiceAmt == null
                  ? 'bg-gray-50 text-gray-600 ring-1 ring-gray-200/60'
                  : balanced
                    ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/60'
                    : 'bg-amber-50 text-amber-700 ring-1 ring-amber-200/60'
              }`}>
                <span className="font-semibold">
                  Total: <span className="tabular-nums">{fmt(sum, cur)}</span>
                  {invoiceAmt != null && <> of <span className="tabular-nums">{fmt(invoiceAmt, cur)}</span> invoice</>}
                </span>
                {invoiceAmt != null && !balanced && (
                  <span className="font-bold tabular-nums">
                    {invoiceAmt - sum > 0 ? `${fmt(invoiceAmt - sum, cur)} left` : `${fmt(sum - invoiceAmt, cur)} over`}
                  </span>
                )}
                {balanced && <CheckCircle2 size={13} />}
              </div>
            )
          })()}
          <div className="flex justify-end gap-2 mt-4 pt-3 border-t border-rule">
            <button onClick={() => setSocialsModal(null)} className="btn-secondary text-xs">Cancel</button>
            <button onClick={saveSocials} disabled={socialsSaving} className="btn-primary text-xs">
              {socialsSaving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Modal>
      )}

      {/* ── Edit row modal (artist / song / category) ─────────────────── */}
      {editModal && (
        <Modal onClose={() => !editSaving && setEditModal(null)} title="Edit row">
          <div className="space-y-3">
            <p className="text-xs text-gray-500">
              Updates flow through the standard ledger PUT endpoint — same path
              the Ledger and Recoupments use. Changing artist or category may
              move this row off the page.
            </p>
            <div>
              <label className="block text-[10px] uppercase tracking-wide font-bold text-gray-500 mb-1">Artist</label>
              <input
                type="text"
                value={editModal.draft.artist}
                onChange={e => setEditDraft({ artist: e.target.value })}
                placeholder="Artist name"
                className="w-full px-3 py-1.5 text-xs rounded-lg bg-card border border-rule focus:outline-none focus:border-boom-400"
                disabled={editSaving}
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wide font-bold text-gray-500 mb-1">Song</label>
              <input
                type="text"
                value={editModal.draft.song}
                onChange={e => setEditDraft({ song: e.target.value })}
                placeholder="Song title"
                className="w-full px-3 py-1.5 text-xs rounded-lg bg-card border border-rule focus:outline-none focus:border-boom-400"
                disabled={editSaving}
              />
              <p className="text-[10px] text-gray-400 mt-1">
                Server auto-splits this row into one child per song if you enter comma-separated values.
              </p>
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wide font-bold text-gray-500 mb-1">Category</label>
              <select
                value={
                  CATEGORIES.includes(editModal.draft.category) || !editModal.draft.category
                    ? editModal.draft.category
                    : '__keep__'
                }
                onChange={e => {
                  if (e.target.value === '__keep__') return
                  setEditDraft({ category: e.target.value })
                }}
                className="w-full px-3 py-1.5 text-xs rounded-lg bg-card border border-rule focus:outline-none focus:border-boom-400"
                disabled={editSaving}
              >
                <option value="">— select category —</option>
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                {editModal.draft.category && !CATEGORIES.includes(editModal.draft.category) && (
                  <option value="__keep__">{editModal.draft.category} (current — non-canonical)</option>
                )}
              </select>
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wide font-bold text-gray-500 mb-1">
                Amount ({editModal.entry.currency || 'USD'})
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={editModal.draft.amount}
                onChange={e => setEditDraft({ amount: e.target.value })}
                placeholder="0.00"
                className="w-full px-3 py-1.5 text-xs rounded-lg bg-card border border-rule focus:outline-none focus:border-boom-400 tabular-nums"
                disabled={editSaving}
              />
              {editModal.entry.parent_id ? (
                <p className="text-[10px] text-gray-400 mt-1">
                  This is a split row — its amount is independent of the parent invoice's total. Adjust to re-balance the split.
                </p>
              ) : (
                <p className="text-[10px] text-gray-400 mt-1">
                  Changes the parent row's amount only; existing split children keep their amounts.
                </p>
              )}
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-4 pt-3 border-t border-rule">
            <button onClick={() => setEditModal(null)} disabled={editSaving} className="btn-secondary text-xs">Cancel</button>
            <button onClick={saveEdit} disabled={editSaving} className="btn-primary text-xs">
              {editSaving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Modal>
      )}

      {/* ── Split-invoice modal ────────────────────────────────────────── */}
      {splitModal && (() => {
        const parentTotal = Number(splitModal.entry.amount) || 0
        const cur = splitModal.entry.currency
        const sum = splitModal.rows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0)
        const diff = parentTotal - sum
        const balanced = Math.abs(diff) < 0.01
        return (
          <Modal onClose={() => !splitSaving && setSplitModal(null)} title="Split invoice">
            <div className="space-y-3">
              <p className="text-xs text-gray-500">
                Splits this {fmt(parentTotal, cur)} invoice from{' '}
                <span className="font-semibold text-gray-700">{splitModal.entry.payee || `#${splitModal.entry.id}`}</span>{' '}
                across songs and/or artists. Every row keeps the same payee and invoice number — change the artist on a row to
                divide the invoice between artists.
              </p>
              <div className="space-y-2">
                <div className="grid grid-cols-12 gap-2 text-[10px] uppercase tracking-wide font-bold text-gray-500">
                  <div className="col-span-4">Artist</div>
                  <div className="col-span-4">Song</div>
                  <div className="col-span-3 text-right">Amount</div>
                  <div className="col-span-1"></div>
                </div>
                {splitModal.rows.map((row, i) => (
                  <div key={i} className="grid grid-cols-12 gap-2 items-center">
                    <input
                      type="text"
                      value={row.artist}
                      onChange={e => updateSplitRow(i, { artist: e.target.value })}
                      placeholder="Artist"
                      disabled={splitSaving}
                      className="col-span-4 px-2 py-1.5 text-xs rounded-lg bg-card border border-rule focus:outline-none focus:border-boom-400"
                    />
                    <input
                      type="text"
                      value={row.song}
                      onChange={e => updateSplitRow(i, { song: e.target.value })}
                      placeholder="Song title"
                      disabled={splitSaving}
                      className="col-span-4 px-2 py-1.5 text-xs rounded-lg bg-card border border-rule focus:outline-none focus:border-boom-400"
                    />
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={row.amount}
                      onChange={e => updateSplitRow(i, { amount: e.target.value })}
                      placeholder="0.00"
                      disabled={splitSaving}
                      className="col-span-3 px-2 py-1.5 text-xs text-right rounded-lg bg-card border border-rule focus:outline-none focus:border-boom-400 tabular-nums"
                    />
                    <button
                      onClick={() => removeSplitRow(i)}
                      disabled={splitSaving || splitModal.rows.length <= 2}
                      className="col-span-1 text-gray-400 hover:text-rose-500 disabled:opacity-30 disabled:cursor-not-allowed"
                      title={splitModal.rows.length <= 2 ? 'A split needs at least two rows' : 'Remove this row'}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
                <button
                  onClick={addSplitRow}
                  disabled={splitSaving}
                  className="text-xs text-boom-600 hover:text-boom-700 font-semibold inline-flex items-center gap-1"
                >
                  <Plus size={11} /> Add another row
                </button>
              </div>
              {/* Running total vs invoice — green when balanced, amber when
                  off (the save still lets the user proceed with a confirm
                  so floating-point oddities don't become a blocker). */}
              <div className={`text-xs rounded-lg px-3 py-2 flex items-center justify-between ${
                balanced
                  ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/60'
                  : 'bg-amber-50 text-amber-700 ring-1 ring-amber-200/60'
              }`}>
                <span className="font-semibold">
                  Total: <span className="tabular-nums">{fmt(sum, cur)}</span> of <span className="tabular-nums">{fmt(parentTotal, cur)}</span>
                </span>
                {!balanced && (
                  <span className="font-bold tabular-nums">
                    {diff > 0 ? `${fmt(diff, cur)} left` : `${fmt(Math.abs(diff), cur)} over`}
                  </span>
                )}
                {balanced && <CheckCircle2 size={13} />}
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4 pt-3 border-t border-rule">
              <button onClick={() => setSplitModal(null)} disabled={splitSaving} className="btn-secondary text-xs">Cancel</button>
              <button onClick={saveSplit} disabled={splitSaving} className="btn-primary text-xs">
                {splitSaving ? 'Splitting…' : `Split into ${splitModal.rows.filter(r => ((r.artist || '').trim() || (r.song || '').trim()) && parseFloat(r.amount) > 0).length} rows`}
              </button>
            </div>
          </Modal>
        )
      })()}

      {/* ── Invoice preview overlay ──────────────────────────────────────── */}
      {previewFile && (
        <FilePreview
          url={previewFile.url}
          filename={previewFile.filename}
          onClose={() => setPreviewFile(null)}
        />
      )}

      {/* ── Undo toast ──────────────────────────────────────────────────── */}
      {undoAction && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2.5 rounded-lg shadow-2xl bg-[#111827] text-white text-xs">
          <span className="font-semibold">{undoAction.message}</span>
          <button
            onClick={executeUndo}
            className="inline-flex items-center gap-1 px-2 py-1 rounded bg-card/10 hover:bg-card/20 font-bold"
          >
            <Undo2 size={11} /> Undo
          </button>
          <button
            onClick={() => setUndoAction(null)}
            className="text-white/50 hover:text-white/80"
            title="Dismiss"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* ── Link campaign → expense modal ────────────────────────────────── */}
      {linkModal && (
        <Modal onClose={() => setLinkModal(null)} title={`Link "${linkModal.campaign.name}" to a ledger row`}>
          <div className="space-y-3">
            <p className="text-xs text-gray-500">
              Pick the matching marketing expense already on the ledger. Picking
              one sets <code>influencer_campaigns.expense_id</code>, which is
              how the artist roll-up tells linked vs unlinked campaigns apart.
            </p>
            <div className="relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                value={linkSearch}
                onChange={e => setLinkSearch(e.target.value)}
                placeholder="Search payee / song / invoice #"
                className="w-full pl-7 pr-3 py-1.5 text-xs rounded-lg bg-card border border-rule"
              />
            </div>
            <div className="max-h-72 overflow-y-auto border border-rule rounded-lg">
              {linkCandidates.length === 0 ? (
                <div className="p-4 text-xs text-gray-400 text-center">
                  No eligible ledger rows. Every spend on this artist is either already linked or is a split child.
                </div>
              ) : (
                linkCandidates.map(e => (
                  <label
                    key={e.id}
                    className={`flex items-center gap-2 p-2 cursor-pointer text-xs border-b border-divider last:border-b-0 ${
                      String(linkSelected) === String(e.id) ? 'bg-boom-50' : 'hover:bg-gray-50'
                    }`}
                  >
                    <input
                      type="radio"
                      name="link-candidate"
                      value={e.id}
                      checked={String(linkSelected) === String(e.id)}
                      onChange={() => setLinkSelected(String(e.id))}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-gray-900 truncate">{e.payee || '(no payee)'}</p>
                      <p className="text-[10px] text-gray-400 truncate">
                        {e.song || '(no song)'} · {e.category} · {e.invoice_number || 'no inv #'} · {formatDate(e.invoice_date)}
                      </p>
                    </div>
                    <span className="font-bold tabular-nums">{fmt(e.amount, e.currency)}</span>
                  </label>
                ))
              )}
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-4 pt-3 border-t border-rule">
            <button onClick={() => setLinkModal(null)} className="btn-secondary text-xs">Cancel</button>
            <button onClick={saveLink} disabled={!linkSelected || linkSaving} className="btn-primary text-xs">
              {linkSaving ? 'Linking…' : 'Link'}
            </button>
          </div>
        </Modal>
      )}

      {/* Add-expense modal — mirrors the Recoupments Add flow.
          Artist is pinned from the route; song is pinned when this
          is the song subpage. Rows created here default to
          artist_campaign='Yes' since they were added from the
          campaign page. */}
      {addModalOpen && (
        <Modal
          onClose={closeAddModal}
          title={isSong
            ? `Add expense — ${detail?.artist || routeArtist} · ${routeSong}`
            : `Add expense — ${detail?.artist || routeArtist}`}
        >
          <div className="space-y-3">
            {addError && (
              <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1.5">
                {addError}
              </div>
            )}
            <div>
              <label className="block text-[10px] uppercase tracking-wide font-bold text-gray-500 mb-1">Payee</label>
              <input
                type="text"
                value={addForm.payee}
                onChange={e => setAddForm(f => ({ ...f, payee: e.target.value }))}
                placeholder="Vendor / creator / agency"
                className="w-full px-3 py-1.5 text-xs rounded-lg bg-card border border-rule focus:outline-none focus:border-boom-400"
                disabled={addSaving}
                autoFocus
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wide font-bold text-gray-500 mb-1">Description</label>
              <input
                type="text"
                value={addForm.description}
                onChange={e => setAddForm(f => ({ ...f, description: e.target.value }))}
                placeholder="What was this for?"
                className="w-full px-3 py-1.5 text-xs rounded-lg bg-card border border-rule focus:outline-none focus:border-boom-400"
                disabled={addSaving}
              />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="block text-[10px] uppercase tracking-wide font-bold text-gray-500 mb-1">Amount</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={addForm.amount}
                  onChange={e => setAddForm(f => ({ ...f, amount: e.target.value }))}
                  placeholder="0.00"
                  className="w-full px-3 py-1.5 text-xs rounded-lg bg-card border border-rule focus:outline-none focus:border-boom-400 tabular-nums"
                  disabled={addSaving}
                />
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-wide font-bold text-gray-500 mb-1">Currency</label>
                <select
                  value={addForm.currency}
                  onChange={e => setAddForm(f => ({ ...f, currency: e.target.value }))}
                  className="w-full px-3 py-1.5 text-xs rounded-lg bg-card border border-rule focus:outline-none focus:border-boom-400"
                  disabled={addSaving}
                >
                  {['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY'].map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-wide font-bold text-gray-500 mb-1">Date</label>
                <input
                  type="date"
                  value={addForm.date}
                  onChange={e => setAddForm(f => ({ ...f, date: e.target.value }))}
                  className="w-full px-3 py-1.5 text-xs rounded-lg bg-card border border-rule focus:outline-none focus:border-boom-400"
                  disabled={addSaving}
                />
              </div>
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wide font-bold text-gray-500 mb-1">Category</label>
              <select
                value={addForm.category}
                onChange={e => setAddForm(f => ({ ...f, category: e.target.value }))}
                className="w-full px-3 py-1.5 text-xs rounded-lg bg-card border border-rule focus:outline-none focus:border-boom-400"
                disabled={addSaving}
              >
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wide font-bold text-gray-500 mb-1">
                Invoice file <span className="text-gray-300">(optional)</span>
              </label>
              <input
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.gif,.webp"
                onChange={e => setAddFile(e.target.files?.[0] || null)}
                className="w-full text-xs text-gray-600 file:mr-3 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:rounded-lg file:border file:border-rule file:bg-card file:text-gray-700 file:cursor-pointer hover:file:border-boom-200"
                disabled={addSaving}
              />
              {addFile && (
                <p className="text-[10px] text-gray-400 mt-1 truncate">{addFile.name}</p>
              )}
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wide font-bold text-gray-500 mb-1">
                Proof of payment <span className="text-gray-300">(optional)</span>
              </label>
              <input
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.gif,.webp"
                onChange={e => setAddProof(e.target.files?.[0] || null)}
                className="w-full text-xs text-gray-600 file:mr-3 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:rounded-lg file:border file:border-rule file:bg-card file:text-gray-700 file:cursor-pointer hover:file:border-boom-200"
                disabled={addSaving}
              />
              {addProof && (
                <>
                  <p className="text-[10px] text-gray-400 mt-1 truncate">{addProof.name}</p>
                  <p className="text-[10px] text-emerald-700 mt-1">
                    Marks this paid and reads the payment date off the document — you don't need to set the date below.
                  </p>
                </>
              )}
            </div>
            {/* Optional socials — [platform] + [handle], one row per
                creator/handle. Empty rows are dropped on submit so we
                don't stamp `[]` onto the expense. */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-[10px] uppercase tracking-wide font-bold text-gray-500">Socials <span className="text-gray-300">(optional)</span></label>
                {(
                  <button
                    type="button"
                    onClick={() => setAddForm(f => ({ ...f, socials: [...(f.socials || []), { platform: 'Instagram', handle: '' }] }))}
                    disabled={addSaving}
                    className="text-[10px] font-semibold text-boom-600 hover:text-boom-700 inline-flex items-center gap-1"
                  >
                    <Plus size={10} /> Add another
                  </button>
                )}
              </div>
              <div className="space-y-1.5">
                {addForm.socials.map((s, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <select
                      value={s.platform}
                      onChange={e => setAddForm(f => ({ ...f, socials: f.socials.map((r, idx) => idx === i ? { ...r, platform: e.target.value } : r) }))}
                      className="w-28 px-2 py-1.5 text-xs rounded-lg bg-card border border-rule focus:outline-none focus:border-boom-400"
                      disabled={addSaving}
                    >
                      {SOCIAL_PLATFORMS.map(p => <option key={p} value={p}>{p}</option>)}
                    </select>
                    <input
                      type="text"
                      value={s.handle}
                      onChange={e => setAddForm(f => ({ ...f, socials: f.socials.map((r, idx) => idx === i ? { ...r, handle: e.target.value } : r) }))}
                      placeholder="@handle or profile URL"
                      className="flex-1 min-w-0 px-3 py-1.5 text-xs rounded-lg bg-card border border-rule focus:outline-none focus:border-boom-400"
                      disabled={addSaving}
                    />
                    {addForm.socials.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setAddForm(f => ({ ...f, socials: f.socials.filter((_, idx) => idx !== i) }))}
                        disabled={addSaving}
                        title="Remove this social"
                        className="p-1 text-gray-300 hover:text-rose-600"
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wide font-bold text-gray-500 mb-1">Notes</label>
              <textarea
                value={addForm.notes}
                onChange={e => setAddForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="Optional"
                rows={2}
                className="w-full px-3 py-1.5 text-xs rounded-lg bg-card border border-rule focus:outline-none focus:border-boom-400 resize-y"
                disabled={addSaving}
              />
            </div>
            {/* Superseded by a proof: the document is better evidence than a
                checkbox, and it carries the real date. Shown disabled rather
                than hidden so the state is explained, not silently changed. */}
            <label className={`flex items-center gap-2 text-xs ${addProof ? 'text-gray-400' : 'text-gray-700 cursor-pointer'}`}>
              <input
                type="checkbox"
                checked={addProof ? true : addForm.paid}
                onChange={e => setAddForm(f => ({ ...f, paid: e.target.checked }))}
                disabled={addSaving || !!addProof}
                className="h-4 w-4 rounded border-rule text-boom-600 focus:ring-boom-400"
              />
              {addProof
                ? 'Already paid — set from the proof of payment, along with its date.'
                : 'Already paid — stamp payment_date to the invoice date.'}
            </label>
            <p className="text-[10px] text-gray-400">
              Pinned to <span className="font-semibold text-gray-600">{detail?.artist || routeArtist}</span>
              {isSong && (
                <> · Song: <span className="font-semibold text-gray-600">{routeSong}</span></>
              )}
              . Row will be marked Campaign=Yes.
            </p>
          </div>
          <div className="flex justify-end gap-2 mt-4 pt-3 border-t border-rule">
            <button onClick={closeAddModal} disabled={addSaving} className="btn-secondary text-xs">Cancel</button>
            <button onClick={saveNewExpense} disabled={addSaving} className="btn-primary text-xs inline-flex items-center gap-1.5">
              {addSaving ? <Loader size={12} className="animate-spin" /> : <Plus size={12} />}
              {addSaving ? 'Saving…' : 'Add Expense'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ── Sub-components ──────────────────────────────────────────────────────────
// Back-link — rendered as a proper button-styled pill so it reads
// as a clickable affordance instead of small grey text. Used above
// the breadcrumb + PageHeader on the artist detail + song subpages
// so the "escape hatch" up to the parent view is obvious at a glance.
function BackLink({ to, label }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-2 text-sm font-semibold text-gray-700 bg-card border border-rule rounded-lg px-3 py-1.5 hover:text-boom-700 hover:border-boom-200 hover:bg-boom-50/40 hover:shadow-sm transition-all group"
    >
      <ArrowLeft size={15} strokeWidth={2.25} className="transition-transform group-hover:-translate-x-0.5" />
      {label}
    </Link>
  )
}

// Read-only paid-status badge. Mirrors the colors the Recoupments page
// uses (emerald=Paid, amber=Partial, rose=everything else). Toggling lives
// on the Ledger / Approvals; this page is reconciliation only.
function PaidBadge({ status, date }) {
  const s = status || 'Unpaid'
  const tone = s === 'Paid'
    ? 'text-emerald-700 bg-emerald-50 ring-emerald-200/60'
    : s === 'Partial'
      ? 'text-amber-700 bg-amber-50 ring-amber-200/60'
      : 'text-rose-700 bg-rose-50 ring-rose-200/60'
  const title = s === 'Paid' && date ? `Paid ${formatDate(date)}` : s
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold ring-1 ${tone}`}
      title={title}
    >
      {s}
    </span>
  )
}

function StatCard({ label, value, sub, tone = 'default' }) {
  const tones = {
    default: 'text-gray-900',
    amber:   'text-amber-700',
    rose:    'text-rose-700',
    green:   'text-emerald-700',
  }
  return (
    <div className="card p-3">
      <p className="text-[10px] uppercase tracking-wide text-gray-400 font-bold">{label}</p>
      <p className={`text-xl font-bold tabular-nums mt-1 ${tones[tone] || tones.default}`}>{value}</p>
      {sub && <p className="text-[10px] text-gray-400 mt-0.5">{sub}</p>}
    </div>
  )
}

function CampaignsTable({ campaigns, ledger, onLink, onUnlink }) {
  const ledgerById = useMemo(() => {
    const m = {}
    ledger.forEach(e => { m[e.id] = e })
    return m
  }, [ledger])

  return (
    <div className="card overflow-hidden">
      <div className="px-4 py-2 border-b border-rule flex items-center gap-2">
        <Megaphone size={13} className="text-boom-500" />
        <h3 className="text-sm font-bold text-gray-700">Marketing team campaigns</h3>
        <span className="text-[10px] text-gray-400">{campaigns.length} on file</span>
      </div>
      <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] sm:min-w-0 text-xs">
        <thead className="bg-gray-50/80 text-[10px] uppercase tracking-wide text-gray-500">
          <tr>
            <th className="text-left px-3 py-2 font-bold">Campaign</th>
            <th className="text-left px-3 py-2 font-bold">Date</th>
            <th className="text-right px-3 py-2 font-bold">Budget</th>
            <th className="text-right px-3 py-2 font-bold">Creators</th>
            <th className="text-left px-3 py-2 font-bold">Linked expense</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {campaigns.map(c => {
            const linkedExpense = c.expense_id ? ledgerById[c.expense_id] : null
            return (
              <tr key={c.id} className="border-t border-divider">
                <td className="px-3 py-2 font-semibold text-gray-900">
                  <div className="truncate max-w-[260px]" title={c.name}>{c.name}</div>
                  {c.platform && c.platform !== 'Cobrand' && (
                    <div className="text-[10px] text-gray-400">{c.platform}</div>
                  )}
                </td>
                <td className="px-3 py-2 text-gray-500 whitespace-nowrap">
                  {c.campaign_date ? formatDate(c.campaign_date) : '—'}
                </td>
                <td className="px-3 py-2 text-right font-bold tabular-nums">
                  {fmtCompact(c.total_budget)}
                </td>
                <td className="px-3 py-2 text-right text-gray-500 tabular-nums">{c.creator_count || 0}</td>
                <td className="px-3 py-2">
                  {linkedExpense ? (
                    <div className="inline-flex items-center gap-1 text-emerald-700 bg-emerald-50 ring-1 ring-emerald-200/60 px-1.5 py-0.5 rounded text-[10px] font-semibold">
                      <CheckCircle2 size={9} />
                      <span className="truncate max-w-[200px]">{linkedExpense.payee || `#${linkedExpense.id}`}</span>
                      <span className="text-emerald-600 font-bold ml-1 tabular-nums">{fmt(linkedExpense.amount, linkedExpense.currency)}</span>
                    </div>
                  ) : c.expense_id ? (
                    <span className="text-[10px] text-gray-400">linked to expense #{c.expense_id}</span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-rose-700 bg-rose-50 ring-1 ring-rose-200/60 px-1.5 py-0.5 rounded text-[10px] font-semibold">
                      <AlertTriangle size={9} /> unlinked
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  {c.expense_id ? (
                    <button
                      onClick={() => onUnlink(c)}
                      className="inline-flex items-center gap-1 text-[11px] text-gray-500 hover:text-rose-600"
                      title="Unlink from current expense"
                    >
                      <Unlink size={11} /> Unlink
                    </button>
                  ) : (
                    <button
                      onClick={() => onLink(c)}
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-boom-600 hover:text-boom-700"
                    >
                      <Link2 size={11} /> Link
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      </div>
    </div>
  )
}

function SongGroup({
  group, collapsed, onToggle,
  onOpenSocials, onOpenEdit, onOpenSplit, onToggleCobrand, onToggleBulkDeal, onTogglePaid, onMarkNotCampaign,
  onOpenSong, hideOpenSong,
  onRestore, onDelete, onPreviewInvoice, hasInvoiceFile, onUploadInvoice,
  currentUser,
  amountSort, onToggleAmountSort,
  finished, onToggleFinished,
  // Flag-for-review support — mirrors the finished checkbox: parent
  // owns state + write; SongGroup just renders + delegates callbacks.
  flagged = false, flagReason = '', onToggleFlag, onSaveFlagReason,
  // Per-expense flag actions plumbed through so the row-action
  // strip can render a FlagButton on every ledger row.
  onToggleExpenseFlag, onSaveExpenseFlagReason, onAssignReviewers,
  // Bulk-selection support — parent owns the Set; SongGroup renders the
  // checkboxes + the per-song select-all in the table header.
  selectedIds, onToggleSelect, onSelectMany,
  // Per-item "done" checkbox — parallels the flag button but tracks
  // review-state instead of flags-for-review.
  onToggleItemFinished,
  onRenameSong,
  // linkMode: on the artist page, each song is a clickable card that
  // navigates to its subpage (no inline accordion). detail mode
  // (default) is used on the song subpage itself, where the entries
  // table renders inline below the header.
  linkMode = false,
}) {
  // Bulk-deal evidence rows — which entry ids have their delivered-post
  // links expanded beneath the row. Local: pure display state.
  const [evidenceOpen, setEvidenceOpen] = useState(() => new Set())

  // Per-row comment threads. Lazy-loaded on first open; counts come with
  // the ledger payload (comment_count) so the icon can badge without an
  // N+1. Once a thread is loaded, its live length wins over the count.
  const [commentsOpen, setCommentsOpen] = useState(() => new Set())
  const [commentsByEntry, setCommentsByEntry] = useState({})
  const [commentDraft, setCommentDraft] = useState({})
  const [commentSaving, setCommentSaving] = useState(null)
  const toggleComments = async (entryId) => {
    const opening = !commentsOpen.has(entryId)
    setCommentsOpen(prev => {
      const n = new Set(prev)
      opening ? n.add(entryId) : n.delete(entryId)
      return n
    })
    if (opening && !commentsByEntry[entryId]) {
      try {
        const r = await api.get(`/bk/entries/${entryId}/comments`)
        setCommentsByEntry(prev => ({ ...prev, [entryId]: r.data?.data || [] }))
      } catch {
        setCommentsByEntry(prev => ({ ...prev, [entryId]: [] }))
      }
    }
  }
  const postComment = async (entryId) => {
    const text = (commentDraft[entryId] || '').trim()
    if (!text) return
    // In-flight guard — the Post button disables on commentSaving but the
    // Enter key path didn't, so a double-Enter posted the comment twice.
    if (commentSaving === entryId) return
    setCommentSaving(entryId)
    try {
      const r = await api.post(`/bk/entries/${entryId}/comments`, { comment: text })
      if (r.data?.data) {
        setCommentsByEntry(prev => ({ ...prev, [entryId]: [...(prev[entryId] || []), r.data.data] }))
        setCommentDraft(prev => ({ ...prev, [entryId]: '' }))
      }
    } catch (err) {
      alert('Failed to post comment: ' + (err.response?.data?.error || err.message))
    } finally {
      setCommentSaving(null)
    }
  }
  const deleteComment = async (entryId, commentId) => {
    try {
      await api.delete(`/bk/entries/comments/${commentId}`)
      setCommentsByEntry(prev => ({ ...prev, [entryId]: (prev[entryId] || []).filter(c => c.id !== commentId) }))
    } catch (err) {
      alert('Failed to delete comment: ' + (err.response?.data?.error || err.message))
    }
  }
  const commentCountFor = (e) =>
    commentsByEntry[e.id] ? commentsByEntry[e.id].length : (Number(e.comment_count) || 0)
  // Every bucket — including the "(no song)" placeholder — opens its
  // own subpage in linkMode. The (no song) subpage is keyed on the
  // NO_SONG_SLUG URL sentinel so it doesn't collide with a real
  // literal "(no song)" title on the ledger.
  const songCanOpen = !hideOpenSong
  const canLink = linkMode && songCanOpen
  const headerClick = canLink
    ? () => onOpenSong?.(group.song)
    : onToggle
  const isStub = !!group.is_release_stub

  // Inline song rename. Only enabled when onRenameSong is passed and
  // the bucket has a real song title (not the "(no song)" placeholder).
  // Editing puts the header into a distinct edit mode that suppresses
  // the outer navigation click, so hovering the pencil doesn't need to
  // fight the linkMode click-through.
  const [renaming, setRenaming] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  const [renameSaving, setRenameSaving] = useState(false)
  const [renameError, setRenameError] = useState(null)
  // Rename is disallowed on the (no song) placeholder — there's no
  // title to rename, and renaming to a real title would collapse the
  // bucket into a real song's group with unclear semantics.
  const canRename = !!onRenameSong && songCanOpen && group.song !== SONG_UNASSIGNED
  const startRename = (e) => {
    e?.stopPropagation?.(); e?.preventDefault?.()
    setRenameDraft(group.song || '')
    setRenameError(null)
    setRenaming(true)
  }
  const cancelRename = () => { setRenaming(false); setRenameDraft(''); setRenameError(null) }
  const commitRename = async () => {
    const next = renameDraft.trim()
    if (!next || next === group.song) { cancelRename(); return }
    setRenameSaving(true); setRenameError(null)
    const result = await onRenameSong(group.song, next)
    setRenameSaving(false)
    if (result?.ok) cancelRename()
    else setRenameError(result?.error || 'Rename failed')
  }
  return (
    <div className={`card overflow-hidden group ${finished ? 'opacity-80' : ''} ${isStub ? 'ring-1 ring-boom-100/60' : ''}`}>
      <button
        onClick={renaming ? undefined : headerClick}
        className={`w-full px-4 py-2.5 flex items-center gap-3 transition-colors ${
          renaming ? '' : 'hover:bg-gray-50'
        }`}
      >
        {canLink
          ? <ChevronRight size={14} className="text-gray-300" />
          : (collapsed
              ? <ChevronRight size={14} className="text-gray-400" />
              : <ChevronDown size={14} className="text-gray-400" />)}
        {/* Prominent finished checkbox — leads the row, todo-item style.
            Nests inside the outer <button>, so stopPropagation is critical:
            without it, a click on the checkbox would ALSO toggle collapse. */}
        {onToggleFinished && (
          <span
            role="checkbox"
            aria-checked={finished ? 'true' : 'false'}
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); e.preventDefault(); onToggleFinished() }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onToggleFinished() } }}
            className={`inline-flex items-center justify-center rounded-full cursor-pointer transition-colors ${
              finished
                ? 'text-emerald-600 hover:text-emerald-700'
                : 'text-gray-300 hover:text-emerald-500'
            }`}
            title={finished
              ? 'Campaign complete — click to reopen'
              : 'Mark campaign complete'}
            style={{ width: 22, height: 22 }}
          >
            {finished
              ? <CheckCircle2 size={20} className="fill-emerald-100" strokeWidth={2.25} />
              : <Circle size={20} strokeWidth={2} />}
          </span>
        )}
        {/* Flag-for-review — sits alongside the finished circle so the
            two toggles read as a paired set ("complete" + "flag").
            Hides via group-hover when not set to avoid distraction. */}
        {onToggleFlag && (
          <FlagButton
            flagged={flagged}
            reason={flagReason}
            onToggle={(next, reason) => onToggleFlag(next, reason ?? null)}
            onSaveReason={(reason) => onSaveFlagReason?.(reason)}
            size="md"
          />
        )}
        <Music2 size={13} className="text-boom-500" />
        {renaming ? (
          // Inline rename input replaces the title. Enter saves, Escape
          // cancels. stopPropagation on click so the outer button doesn't
          // steal focus mid-edit.
          <span className="flex-1 min-w-0 flex items-center gap-2" onClick={e => e.stopPropagation()}>
            <input
              type="text"
              autoFocus
              value={renameDraft}
              onChange={e => setRenameDraft(e.target.value.slice(0, 200))}
              onKeyDown={e => {
                if (e.key === 'Enter')  { e.preventDefault(); commitRename() }
                else if (e.key === 'Escape') { e.preventDefault(); cancelRename() }
              }}
              disabled={renameSaving}
              className="flex-1 min-w-0 text-sm font-bold text-gray-900 bg-card border border-boom-300 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-boom-400"
              placeholder="Song title"
            />
            <button
              type="button"
              onClick={e => { e.stopPropagation(); e.preventDefault(); commitRename() }}
              disabled={renameSaving || !renameDraft.trim() || renameDraft.trim() === group.song}
              title="Save (Enter)"
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40"
            >
              Save
            </button>
            <button
              type="button"
              onClick={e => { e.stopPropagation(); e.preventDefault(); cancelRename() }}
              disabled={renameSaving}
              title="Cancel (Esc)"
              className="text-xs font-semibold text-gray-500 hover:text-gray-700 px-2 py-1 rounded hover:bg-gray-100"
            >
              Cancel
            </button>
            {renameError && (
              <span className="text-[11px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1">
                {renameError}
              </span>
            )}
          </span>
        ) : (
          <>
            <span className={`text-sm font-bold truncate ${finished ? 'text-gray-500 line-through' : 'text-gray-900'}`}>{group.song}</span>
            {canRename && (
              <span
                role="button"
                tabIndex={0}
                onClick={startRename}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startRename(e) } }}
                title="Rename this song — cascades to ledger rows, release tracker, and campaign notes"
                className="text-gray-300 hover:text-boom-600 p-0.5 rounded hover:bg-boom-50 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity cursor-pointer"
              >
                <Pencil size={11} />
              </span>
            )}
            {isStub ? (
              <span
                className="text-[10px] font-semibold text-boom-600 bg-boom-50 ring-1 ring-boom-200/60 px-1.5 py-0.5 rounded"
                title={group.release_date ? `Release date: ${group.release_date}` : 'From Release Tracker'}
              >
                {group.release_type || 'Release'}{group.release_date ? ` · ${group.release_date}` : ''}
              </span>
            ) : (
              <span className="text-[10px] text-gray-400">
                {group.count} row{group.count === 1 ? '' : 's'}
              </span>
            )}
          </>
        )}
        {group.missingSocials > 0 && (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold text-amber-700 bg-amber-50 ring-1 ring-amber-200/60">
            <AtSign size={9} /> {group.missingSocials} missing
          </span>
        )}
        {group.unpaidCount > 0 && (
          <span
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold text-rose-700 bg-rose-50 ring-1 ring-rose-200/60"
            title={`${fmtTotals(group.unpaidTotals)} unpaid across ${group.unpaidCount} row${group.unpaidCount === 1 ? '' : 's'}`}
          >
            {group.unpaidCount} unpaid
          </span>
        )}
        {/* What the BANK has not shown yet. Invoice-side by necessity — the
            cards' Settled figure has no song dimension — so it says "unsettled"
            and never claims to be that number. */}
        {group.unsettledTotals && Object.keys(group.unsettledTotals).length > 0 && (
          <span
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold ring-1 ${
              group.noBankLineCount > 0
                ? 'text-rose-700 bg-rose-50 ring-rose-200/60'
                : 'text-gray-500 bg-gray-50 ring-rule'}`}
            title={group.noBankLineCount > 0
              ? `${group.noBankLineCount} row${group.noBankLineCount === 1 ? '' : 's'} marked paid where a statement covering the date shows no matching line`
              : 'Invoiced but no bank line behind it yet — either unpaid, or the statement is not in'}
          >
            {fmtTotals(group.unsettledTotals)} unsettled
          </span>
        )}
        <span className="ml-auto font-bold text-sm tabular-nums text-gray-700">
          {isStub ? <span className="text-gray-300">no spend yet</span> : fmtTotals(group.totals)}
        </span>
        {/* linkMode: the whole card is the click target, so the trailing
            "Open →" affordance is redundant. detail mode keeps it for
            the small chevron-icon → subpage path. */}
        {!canLink && songCanOpen && (
          <span
            onClick={(e) => { e.stopPropagation(); onOpenSong(group.song) }}
            className="text-[11px] font-semibold text-boom-600 hover:text-boom-700 px-2 py-1 rounded hover:bg-boom-50"
            title="Open song subpage"
          >
            Open →
          </span>
        )}
      </button>
      {!canLink && !collapsed && (
        <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] sm:min-w-0 text-xs">
          <thead className="bg-gray-50/60 text-[10px] uppercase tracking-wide text-gray-500">
            <tr>
              {/* Selection + two icon columns at the left: select-all
                  checkbox, done circle, flag chip. */}
              <th className="px-2 py-2 w-8">
                {onSelectMany && (() => {
                  const ids = group.entries.map(en => en.id)
                  const allSel = ids.length > 0 && ids.every(id => selectedIds?.has(id))
                  return (
                    <input
                      type="checkbox"
                      checked={allSel}
                      onChange={() => onSelectMany(ids, !allSel)}
                      title={allSel ? 'Deselect all rows in this song' : 'Select all rows in this song'}
                      className="h-3.5 w-3.5 rounded border-gray-300 text-boom-600 focus:ring-boom-500 cursor-pointer"
                    />
                  )
                })()}
              </th>
              <th className="px-2 py-2 w-8"></th>
              <th className="px-2 py-2 w-8"></th>
              <th className="text-left px-4 py-2 font-bold">Date</th>
              <th className="text-left px-3 py-2 font-bold">Payee</th>
              <th className="text-left px-3 py-2 font-bold">Category</th>
              <th className="text-left px-3 py-2 font-bold">Socials</th>
              <th className="text-right px-3 py-2 font-bold">
                <button
                  type="button"
                  onClick={onToggleAmountSort}
                  title={
                    amountSort === 'desc' ? 'Sorted highest → lowest. Click for lowest → highest.' :
                    amountSort === 'asc'  ? 'Sorted lowest → highest. Click to reset to date order.' :
                    'Sort by amount (highest first)'
                  }
                  className="inline-flex items-center gap-1 font-bold uppercase tracking-wide hover:text-boom-600"
                >
                  Amount
                  <span className={amountSort ? 'text-boom-600' : 'text-gray-300'}>
                    {amountSort === 'desc' ? '▼' : amountSort === 'asc' ? '▲' : '↕'}
                  </span>
                </button>
              </th>
              <th className="text-left px-3 py-2 font-bold">Paid?</th>
              <th className="text-left px-3 py-2 font-bold">Campaign</th>
              <th className="px-2 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {(() => {
              // group.entries is already sorted by category (parents grouped
              // with their children). Slice into consecutive same-category
              // sections so we can emit a subheader before each one showing
              // the category name + per-currency total.
              // Children in a split family inherit their parent's section
              // even if the child's own category differs. Keeps the ↳
              // parent-child pairing visually intact (see the sort step
              // where children were attached to parents). In the ~99%
              // case both match anyway — children of a split are INSERTed
              // with the parent's category server-side.
              const parentCat = new Map()
              for (const e of group.entries) {
                if (!e.parent_id) {
                  parentCat.set(e.id, (e.category || '').trim() || 'Uncategorized')
                }
              }
              const sectionCatFor = (e) => {
                if (e.parent_id && parentCat.has(e.parent_id)) return parentCat.get(e.parent_id)
                return (e.category || '').trim() || 'Uncategorized'
              }
              // Merge by category name so an orphan child (parent lives
              // in a different song bucket) doesn't start its own second
              // Marketing section at the bottom. Preserve first-seen
              // order so the section ordering still matches
              // songGroups' category-alphabetical sort.
              const sectionMap = new Map()
              const sectionOrder = []
              for (const e of group.entries) {
                const cat = sectionCatFor(e)
                if (!sectionMap.has(cat)) {
                  sectionMap.set(cat, { category: cat, entries: [] })
                  sectionOrder.push(cat)
                }
                sectionMap.get(cat).entries.push(e)
              }
              const sections = sectionOrder.map(c => sectionMap.get(c))
              const rows = []
              for (const section of sections) {
                const totals = groupByCurrency(section.entries)
                rows.push(
                  <tr
                    key={`cat-${section.category}`}
                    className="bg-gray-50/70 border-t border-divider"
                  >
                    <td colSpan={11} className="px-4 py-1.5">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wide">
                          {section.category}
                          <span className="ml-2 text-gray-300 font-normal">
                            {section.entries.length} row{section.entries.length === 1 ? '' : 's'}
                          </span>
                        </span>
                        <span className="text-[11px] font-semibold text-gray-600 tabular-nums">
                          {fmtTotals(totals)}
                        </span>
                      </div>
                    </td>
                  </tr>
                )
                for (const e of section.entries) {
                  const { handles, fromParent } = rowSocials(e)
                  const isChild = !!e.parent_id
                  rows.push(
                    <tr
                      key={e.id}
                      // Subtle wash by origin so a rep can eyeball where
                      // each row came from:
                      //   indigo → born on the Artist Campaigns page
                      //   purple → born on the Recoupments page
                      // Dismissed rows keep their gray tint — dismissal is
                      // a more actionable signal than provenance. Same
                      // palette the Ledger uses for its left-border stripes
                      // so the visual signal stays consistent across pages.
                      className={
                        e.dismissed
                          ? 'border-t border-divider hover:bg-gray-50/60 opacity-50 bg-gray-50/40'
                          : e.item_finished
                            // A flag is an open question — it must stay visible
                            // even after the row is marked done, so flagged rows
                            // keep an amber wash instead of blending into the
                            // uniform done-green.
                            ? e.flagged
                              ? 'border-t border-divider bg-amber-50/70 hover:bg-amber-100/60 opacity-80'
                              : 'border-t border-divider bg-emerald-50/40 hover:bg-emerald-50/70 opacity-70'
                            : e.entry_source === 'artist_campaigns'
                              ? 'border-t border-divider bg-indigo-50 hover:bg-indigo-100'
                              : e.entry_source === 'recoupments'
                                ? 'border-t border-divider bg-purple-50 hover:bg-purple-100'
                                : 'border-t border-divider hover:bg-gray-50/60'
                      }
                      style={e.item_finished ? { textDecoration: 'line-through' } : undefined}
                      title={
                        e.item_finished && e.flagged          ? 'Marked done but still FLAGGED — resolve the flag or unmark' :
                        e.item_finished                       ? 'Marked done — click the check circle to unmark' :
                        e.entry_source === 'artist_campaigns' ? 'Added from the Artist Campaigns page' :
                        e.entry_source === 'recoupments'      ? 'Added from the Recoupments page'      :
                        undefined
                      }
                    >
                  {/* Selection checkbox — feeds the floating bulk-action
                      bar (cobrand / bulk deal / paid). */}
                  <td className="px-2 py-2 align-middle" onClick={ev => ev.stopPropagation()}>
                    {onToggleSelect && (
                      <input
                        type="checkbox"
                        checked={!!selectedIds?.has(e.id)}
                        onChange={() => onToggleSelect(e.id)}
                        className="h-3.5 w-3.5 rounded border-gray-300 text-boom-600 focus:ring-boom-500 cursor-pointer"
                      />
                    )}
                  </td>
                  {/* Leftmost check circle — mirrors the finished-song
                      circle on the song header, but per-row. Emerald-
                      filled when marked done; empty outline otherwise.
                      Alone in its own td so the flag column keeps its
                      existing width + styling. */}
                  <td className="px-2 py-2 align-middle" onClick={ev => ev.stopPropagation()}>
                    {onToggleItemFinished && (
                      <button
                        type="button"
                        onClick={() => onToggleItemFinished(e.id, !e.item_finished)}
                        title={e.item_finished
                          ? `Marked done${e.item_finished_by_name ? ` by ${e.item_finished_by_name}` : ''}${e.item_finished_at ? ` · ${formatDate(e.item_finished_at)}` : ''} — click to unmark`
                          : 'Mark this item as done / reviewed'}
                        aria-pressed={!!e.item_finished}
                        className={`inline-flex items-center justify-center w-5 h-5 rounded-full ring-1 transition-colors ${
                          e.item_finished
                            ? 'bg-emerald-500 text-white ring-emerald-500 hover:bg-emerald-600'
                            : 'bg-transparent text-transparent ring-gray-300 hover:ring-emerald-400 hover:text-emerald-500'
                        }`}
                      >
                        <CheckCircle2 size={12} strokeWidth={3} />
                      </button>
                    )}
                  </td>
                  {/* Leftmost flag column — chip renders even when the
                      row isn't flagged so operators can start one from
                      here. Portaled popover (see FlagButton) escapes
                      the SongGroup card's overflow-hidden. */}
                  <td className="px-2 py-2 align-middle whitespace-nowrap">
                    <span className="inline-flex items-center">
                      {onToggleExpenseFlag && (
                        <FlagButton
                          flagged={!!e.flagged}
                          reason={e.flag_reason || ''}
                          flaggedBy={e.flagged_by_name || ''}
                          flaggedAt={e.flagged_at}
                          onToggle={(next, reason) => onToggleExpenseFlag(e.id, next, reason ?? null)}
                          onSaveReason={(reason) => onSaveExpenseFlagReason?.(e.id, reason)}
                          size="sm"
                          alwaysVisible
                        />
                      )}
                      {/* Route the flag to specific reviewers right where it's
                          raised — same review_assignments the home-page inbox
                          reads, so assignments made here appear there. */}
                      <AssignReviewersButton
                        entryId={e.id}
                        assignees={e.review_assignees || []}
                        onChange={onAssignReviewers}
                      />
                    </span>
                  </td>
                  <td className="px-4 py-2 text-gray-500 whitespace-nowrap">{formatDate(e.invoice_date)}</td>
                  <td className="px-3 py-2 font-semibold text-gray-900">
                    {isChild && <span className="text-gray-300 mr-1">↳</span>}
                    {e.payee || '—'}
                    {e.invoice_number && (
                      <span className="ml-1 text-[10px] text-gray-400">#{e.invoice_number}</span>
                    )}
                    {/* Bulk-deal chip — delivered vs contracted, from the
                        Bulk Deals deliverables tracker. Click to expand the
                        evidence links (delivered posts) under the row. */}
                    {!isChild && e.is_bulk_deal && (
                      <button
                        type="button"
                        onClick={(ev) => {
                          ev.stopPropagation()
                          if (!(e.bulk_evidence || []).length) return
                          setEvidenceOpen(prev => {
                            const n = new Set(prev)
                            n.has(e.id) ? n.delete(e.id) : n.add(e.id)
                            return n
                          })
                        }}
                        title={(e.bulk_evidence || []).length
                          ? 'Bulk deal — click to show the delivered posts'
                          : 'Bulk deal — no post links logged yet (add them on the Bulk Deals page)'}
                        className={`ml-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold ring-1 bg-teal-50 text-teal-700 ring-teal-200/70 ${(e.bulk_evidence || []).length ? 'hover:bg-teal-100 cursor-pointer' : 'cursor-default'}`}
                      >
                        <Package size={11} /> {e.bulk_delivered ?? 0}/{e.bulk_deal_quantity || e.bulk_items_total || '—'}
                      </button>
                    )}
                  </td>
                  <td className="px-3 py-2 text-gray-500">{e.category}</td>
                  <td className="px-3 py-2">
                    {handles.length > 0 ? (
                      // Two visual states: (a) inherited from the parent
                      // — muted chip; clicking opens the editor RETARGETED
                      // at the parent row (where the socials JSONB lives),
                      // since the parent is often bucketed under another
                      // song and not visible here. (b) own socials —
                      // regular clickable chip.
                      <button
                        onClick={() => onOpenSocials(e)}
                        title={
                          fromParent
                            ? 'Shared across this split invoice — click to edit (tag a handle to an artist to scope it)\n' + handles.map(h => h.display).join('\n')
                            : handles.map(h => h.display).join('\n')
                        }
                        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold ring-1 truncate max-w-[180px] ${
                          fromParent
                            ? 'bg-gray-50 ring-gray-200/60 text-gray-500 hover:bg-gray-100 hover:text-gray-700'
                            : 'bg-gray-100 ring-sky-200/60 text-sky-700 hover:bg-gray-200'
                        }`}
                      >
                        <AtSign size={9} />
                        <span className="truncate">{handles[0].display}</span>
                        {handles.length > 1 && <span className="text-sky-500 font-bold">+{handles.length - 1}</span>}
                      </button>
                    ) : (() => {
                      // Amber "Add socials" is loud on purpose — a row
                      // in a category where socials matter is a live
                      // to-do. For categories where they don't (Recording,
                      // Mixing, Distribution, Legal, etc.) render a
                      // muted gray affordance instead: the row can still
                      // gain socials if the operator wants (e.g. a
                      // cobrand producer with a public IG), but it stops
                      // pulling focus away from the actual missing rows.
                      // Cobrand rows always keep the loud style regardless
                      // of category — same rule the server's missing-
                      // socials flag uses.
                      const SOCIALS_CATEGORIES = new Set(['Marketing', 'PR'])
                      const needsSocials = SOCIALS_CATEGORIES.has(e.category) || !!e.cobrand
                      const classes = needsSocials
                        ? 'text-amber-700 bg-amber-50 ring-1 ring-amber-200/60 hover:bg-amber-100'
                        : 'text-gray-400 bg-transparent ring-1 ring-gray-200/60 hover:text-gray-600 hover:bg-gray-50'
                      return (
                        <button
                          onClick={() => onOpenSocials(e)}
                          title={needsSocials
                            ? 'Add socials for this row'
                            : 'This category typically doesn\'t need socials — click if you want to add them anyway'}
                          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold ${classes}`}
                        >
                          <Plus size={9} /> Add socials
                        </button>
                      )
                    })()}
                  </td>
                  <td className="px-3 py-2 text-right font-bold tabular-nums">{fmt(e.amount, e.currency)}</td>
                  <td className="px-3 py-2">
                    {/* Added expenses (born on this page or Recoupments) get a
                        clickable badge so users can flip Paid/Unpaid inline.
                        Everything else keeps the read-only badge — invoice
                        payment state belongs to the Payment Dashboard. */}
                    {['artist_campaigns', 'recoupments'].includes(e.entry_source) ? (
                      <HoverTip tip={e.payment_status === 'Paid' ? 'Click to mark as unpaid' : 'Click to mark as paid'}>
                        <button
                          onClick={() => onTogglePaid(e)}
                          className="hover:opacity-70 transition-opacity"
                        >
                          <PaidBadge status={e.payment_status} date={e.payment_date} />
                        </button>
                      </HoverTip>
                    ) : (
                      <PaidBadge status={e.payment_status} date={e.payment_date} />
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {e.campaign_id ? (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold text-emerald-700 bg-emerald-50 ring-1 ring-emerald-200/60" title={e.campaign_name}>
                        <Link2 size={9} />
                        <span className="truncate max-w-[140px]">{e.campaign_name}</span>
                      </span>
                    ) : (
                      <span className="text-[10px] text-gray-400">—</span>
                    )}
                  </td>
                  {/* Row actions: Invoice, Cobrand, Edit, Split,
                      Not-campaign, Dismiss/Restore.
                      Every action except Split renders on split children
                      too — each child carries its own artist / song /
                      category / cobrand / dismissed state. Split stays
                      parent-only because the parent_id schema is single-
                      level and splitting a child would need a grandchild
                      row. */}
                  <td className="px-2 py-2 text-right whitespace-nowrap">
                    {/* Icon-only strip: every control is wrapped in HoverTip
                        so the label appears the instant the cursor lands —
                        native title tooltips were too slow/subtle to read. */}
                    <div className="campaign-row-actions inline-flex items-center gap-1">
                      {hasInvoiceFile(e) ? (
                        <HoverTip tip="View invoice">
                          <button
                            onClick={() => onPreviewInvoice(e)}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-50 text-blue-700 hover:bg-blue-100"
                          >
                            <FileText size={11} />
                          </button>
                        </HoverTip>
                      ) : (
                        <HoverTip tip="No invoice on file — click to upload the creator's invoice onto this row">
                          <button
                            onClick={() => onUploadInvoice(e)}
                            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] text-gray-300 hover:text-blue-700 hover:bg-blue-50"
                          >
                            <FileText size={11} /><Plus size={8} />
                          </button>
                        </HoverTip>
                      )}
                      {/* Cobrand toggle — flips the expenses.cobrand boolean.
                          Same column the Recoupments cobrand chip reads from,
                          so a row marked here shows up tinted there too. */}
                      {(() => {
                        const isCobrand = !!e.cobrand
                        return (
                          <HoverTip tip={isCobrand ? 'Cobrand — click to remove' : 'Mark this expense as cobrand'}>
                            <button
                              onClick={() => onToggleCobrand(e)}
                              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold ring-1 ${
                                isCobrand
                                  ? 'bg-blue-50 text-blue-700 ring-blue-200/60 hover:bg-blue-100'
                                  : 'bg-gray-50 text-gray-400 ring-gray-200/60 hover:bg-gray-100 hover:text-gray-600'
                              }`}
                            >
                              <Sparkles size={11} />
                            </button>
                          </HoverTip>
                        )
                      })()}
                      {/* Bulk-deal toggle — teal to match the Ledger's Bulk
                          badge and the Bulk Deals page accent. */}
                      {(() => {
                        const isBulk = !!e.is_bulk_deal
                        return (
                          <HoverTip tip={isBulk ? 'Bulk deal — click to remove' : 'Mark as a bulk deal (shows on the Bulk Deals page)'}>
                            <button
                              onClick={() => onToggleBulkDeal(e)}
                              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold ring-1 ${
                                isBulk
                                  ? 'bg-teal-50 text-teal-700 ring-teal-200/60 hover:bg-teal-100'
                                  : 'bg-gray-50 text-gray-400 ring-gray-200/60 hover:bg-gray-100 hover:text-gray-600'
                              }`}
                            >
                              <Package size={11} />
                            </button>
                          </HoverTip>
                        )
                      })()}
                      <HoverTip tip="Edit artist / song / category">
                        <button
                          onClick={() => onOpenEdit(e)}
                          className="text-gray-400 hover:text-boom-600 p-1"
                        >
                          <Edit2 size={12} />
                        </button>
                      </HoverTip>
                      {/* Split stays parent-only — splitting a child would
                          need a grandchild row, which the parent_id schema
                          doesn't support. */}
                      {!isChild && !e.dismissed && (
                        <HoverTip tip="Split this invoice across songs or between artists with custom amounts">
                          <button
                            onClick={() => onOpenSplit(e)}
                            className="text-gray-400 hover:text-boom-600 p-1"
                          >
                            <GitBranch size={12} />
                          </button>
                        </HoverTip>
                      )}
                      {!e.dismissed && (
                        <HoverTip tip="Not a campaign expense — moves to the section at the bottom of the page">
                          <button
                            onClick={() => onMarkNotCampaign(e)}
                            className="text-gray-400 hover:text-amber-600 p-1"
                          >
                            <Archive size={12} />
                          </button>
                        </HoverTip>
                      )}
                      {/* Jump to this row in the master Ledger — ?focus=
                          scrolls it into view + spotlights it (auto-expands
                          the parent group for split children). */}
                      <HoverTip tip="Open this row in the Ledger">
                        <Link
                          to={`/bk/ledger?focus=${e.id}`}
                          onClick={ev => ev.stopPropagation()}
                          className="text-gray-400 hover:text-boom-600 p-1"
                        >
                          <ExternalLink size={12} />
                        </Link>
                      </HoverTip>
                      {/* Comment thread toggle — badge shows the count so a
                          row with an open question is visible at a glance. */}
                      <HoverTip tip={commentCountFor(e) > 0
                        ? `${commentCountFor(e)} comment${commentCountFor(e) === 1 ? '' : 's'} — click to ${commentsOpen.has(e.id) ? 'hide' : 'view'}`
                        : 'Start a comment thread on this row'}>
                        <button
                          onClick={() => toggleComments(e.id)}
                          className={`relative p-1 ${commentCountFor(e) > 0 ? 'text-sky-600 hover:text-sky-700' : 'text-gray-400 hover:text-sky-600'}`}
                        >
                          <MessageSquare size={12} />
                          {commentCountFor(e) > 0 && (
                            <span className="absolute -top-0.5 -right-0.5 min-w-[12px] h-3 px-0.5 rounded-full bg-sky-600 text-white text-[8px] font-bold leading-3 text-center">
                              {commentCountFor(e)}
                            </span>
                          )}
                        </button>
                      </HoverTip>
                      {e.dismissed ? (
                        <HoverTip tip="Restore — bring this row back onto the page">
                          <button
                            onClick={() => onRestore(e)}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 ring-1 ring-emerald-200/60"
                          >
                            <Undo2 size={10} /> Restore
                          </button>
                        </HoverTip>
                      ) : (
                        <HoverTip tip="Delete — removes this expense everywhere in the app (asks to confirm)">
                          <button
                            onClick={() => onDelete(e)}
                            className="text-gray-400 hover:text-red-600 p-1"
                          >
                            <Trash2 size={12} />
                          </button>
                        </HoverTip>
                      )}
                    </div>
                  </td>
                    </tr>
                  )
                  // Comment thread row — expanded by the MessageSquare
                  // toggle in the actions cluster. Same full-width extra-
                  // <tr> pattern as the bulk-deal evidence row below.
                  if (commentsOpen.has(e.id)) {
                    const thread = commentsByEntry[e.id]
                    rows.push(
                      <tr key={`comments-${e.id}`} className="border-t border-divider bg-sky-50/40">
                        <td colSpan={11} className="px-10 py-2.5">
                          <div className="max-w-2xl space-y-1.5">
                            {thread === undefined ? (
                              <p className="text-[11px] text-gray-400 italic">Loading…</p>
                            ) : thread.length === 0 ? (
                              <p className="text-[11px] text-gray-400 italic">No comments yet — start the thread.</p>
                            ) : thread.map(c => (
                              <div key={c.id} className="group/cmt flex items-start gap-2 text-xs">
                                <span className="font-bold text-gray-900 shrink-0">{c.user_name}</span>
                                <span className="text-gray-700 whitespace-pre-wrap break-words flex-1">{c.comment}</span>
                                <span className="text-[10px] text-gray-400 shrink-0 whitespace-nowrap">
                                  {new Date(c.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                                </span>
                                {(c.user_id === currentUser?.id || ['Admin', 'Superadmin'].includes(currentUser?.role)) && (
                                  <button
                                    onClick={() => deleteComment(e.id, c.id)}
                                    className="opacity-0 group-hover/cmt:opacity-100 text-gray-300 hover:text-rose-500 shrink-0"
                                    title="Delete comment"
                                  >
                                    <X size={11} />
                                  </button>
                                )}
                              </div>
                            ))}
                            <div className="flex items-center gap-2 pt-1">
                              <input
                                type="text"
                                value={commentDraft[e.id] || ''}
                                onChange={ev => setCommentDraft(prev => ({ ...prev, [e.id]: ev.target.value.slice(0, 2000) }))}
                                onKeyDown={ev => { if (ev.key === 'Enter') postComment(e.id) }}
                                placeholder="Add a comment…"
                                className="flex-1 rounded-lg border border-rule px-2 py-1.5 text-xs bg-card focus:outline-none focus:ring-1 focus:ring-sky-400"
                              />
                              <button
                                onClick={() => postComment(e.id)}
                                disabled={commentSaving === e.id || !(commentDraft[e.id] || '').trim()}
                                className="btn-primary text-xs disabled:opacity-40"
                              >
                                {commentSaving === e.id ? 'Posting…' : 'Post'}
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )
                  }
                  // Evidence row — the bulk deal's delivered posts, expanded
                  // by clicking the 📦 chip on the payee cell. One extra
                  // <tr> spanning the table so the links read as belonging
                  // to the row above.
                  if (e.is_bulk_deal && evidenceOpen.has(e.id) && Array.isArray(e.bulk_evidence) && e.bulk_evidence.length > 0) {
                    rows.push(
                      <tr key={`evidence-${e.id}`} className="border-t border-divider bg-teal-50/40">
                        <td colSpan={11} className="px-10 py-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[10px] font-bold uppercase tracking-wide text-teal-700">Delivered posts</span>
                            {e.bulk_evidence.map((ev, i) => (
                              <a
                                key={i}
                                href={ev.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={evt => evt.stopPropagation()}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold bg-card ring-1 ring-teal-200/70 text-teal-700 hover:bg-teal-50"
                                title={ev.completed ? 'Delivered' : 'Logged, not yet marked delivered'}
                              >
                                {ev.completed ? '✓' : '○'} {ev.platform ? `${ev.platform} · ` : ''}{ev.title}
                                <Link2 size={10} />
                              </a>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )
                  }
                }
              }
              return rows
            })()}
          </tbody>
        </table>
        </div>
      )}
    </div>
  )
}

// "Not a campaign expense" section. A muted, collapsible table for rows
// the user has flagged as out-of-scope for campaign reconciliation. Sits
// at the bottom of the page so the segregation is visible but doesn't
// pull focus away from the campaign work above. Each row has an "Restore"
// button to undo the flag.
// Release-stub section — songs that live in the Release Tracker but have
// no ledger spend on file yet. Rendered at the bottom of the artist page
// as a compact list; collapsed by default. Each row is a click-through
// to its subpage where notes can be added ahead of any campaign spend.
function ReleaseStubsSection({ stubs, onOpenSong }) {
  const [collapsed, setCollapsed] = useState(true)
  return (
    <div className="card overflow-hidden border-dashed">
      <button
        onClick={() => setCollapsed(v => !v)}
        className="w-full px-4 py-2.5 flex items-center gap-3 hover:bg-gray-50 transition-colors"
      >
        {collapsed
          ? <ChevronRight size={14} className="text-gray-400" />
          : <ChevronDown size={14} className="text-gray-400" />}
        <Music2 size={13} className="text-gray-400" />
        <span className="text-sm font-bold text-gray-700">Releases without spend</span>
        <span className="text-[10px] text-gray-400">
          {stubs.length} song{stubs.length === 1 ? '' : 's'} in the Release Tracker · no invoices on file
        </span>
      </button>
      {!collapsed && (
        <div className="border-t border-divider divide-y divide-divider">
          {stubs.map(s => (
            <button
              key={s.key}
              onClick={() => onOpenSong(s.song)}
              className="w-full flex items-center gap-3 px-4 py-2 text-left hover:bg-boom-50/40 transition-colors"
            >
              <ChevronRight size={12} className="text-gray-300" />
              <Music2 size={12} className="text-boom-500" />
              <span className="text-sm font-semibold text-gray-800 truncate">{s.song}</span>
              {(s.release_type || s.release_date) && (
                <span className="text-[10px] font-semibold text-boom-600 bg-boom-50 ring-1 ring-boom-200/60 px-1.5 py-0.5 rounded">
                  {s.release_type || 'Release'}
                  {s.release_date ? ` · ${String(s.release_date).slice(0, 10)}` : ''}
                </span>
              )}
              <span className="ml-auto text-[11px] text-gray-300">no spend yet</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function NotCampaignSection({ entries, onRestore, onPreviewInvoice, hasInvoiceFile }) {
  const [collapsed, setCollapsed] = useState(false)
  const totals = useMemo(() => {
    const m = {}
    for (const e of entries) {
      if (!e?.amount) continue
      const cur = (e.currency || 'USD').toUpperCase()
      m[cur] = (m[cur] || 0) + parseFloat(e.amount || 0)
    }
    return m
  }, [entries])
  return (
    <div className="card overflow-hidden border-dashed bg-gray-50/40">
      <button
        onClick={() => setCollapsed(v => !v)}
        className="w-full px-4 py-2.5 flex items-center gap-3 hover:bg-gray-100/40 transition-colors"
      >
        {collapsed
          ? <ChevronRight size={14} className="text-gray-400" />
          : <ChevronDown size={14} className="text-gray-400" />}
        <Archive size={13} className="text-amber-600" />
        <span className="text-sm font-bold text-gray-700">Not a campaign expense</span>
        <span className="text-[10px] text-gray-400">
          {entries.length} row{entries.length === 1 ? '' : 's'} · excluded from campaign totals
        </span>
        <span className="ml-auto font-bold text-sm tabular-nums text-gray-500">{fmtTotals(totals)}</span>
      </button>
      {!collapsed && (
        <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] sm:min-w-0 text-xs">
          <thead className="bg-gray-50/60 text-[10px] uppercase tracking-wide text-gray-500">
            <tr>
              <th className="text-left px-4 py-2 font-bold">Date</th>
              <th className="text-left px-3 py-2 font-bold">Payee</th>
              <th className="text-left px-3 py-2 font-bold">Category</th>
              <th className="text-left px-3 py-2 font-bold">Song</th>
              <th className="text-right px-3 py-2 font-bold">Amount</th>
              <th className="px-2 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {entries.map(e => (
              <tr key={e.id} className="border-t border-divider hover:bg-gray-50/60">
                <td className="px-4 py-2 text-gray-500 whitespace-nowrap">{formatDate(e.invoice_date)}</td>
                <td className="px-3 py-2 font-semibold text-gray-900 truncate max-w-[45vw] sm:max-w-[220px]">
                  {e.payee || '—'}
                  {e.invoice_number && (
                    <span className="ml-1 text-[10px] text-gray-400">#{e.invoice_number}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-gray-500">{e.category}</td>
                <td className="px-3 py-2 text-gray-500 truncate max-w-[40vw] sm:max-w-[180px]">{e.song || '—'}</td>
                <td className="px-3 py-2 text-right font-bold tabular-nums">{fmt(e.amount, e.currency)}</td>
                <td className="px-2 py-2 text-right whitespace-nowrap">
                  <div className="campaign-row-actions inline-flex items-center gap-1">
                    {hasInvoiceFile(e) && (
                      <button
                        onClick={() => onPreviewInvoice(e)}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-50 text-blue-700 hover:bg-blue-100"
                        title="View invoice"
                      >
                        <FileText size={11} />
                      </button>
                    )}
                    <button
                      onClick={() => onRestore(e)}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 ring-1 ring-emerald-200/60"
                      title="Restore — move this row back into the campaign view above"
                    >
                      <ArchiveRestore size={10} /> Restore
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  )
}

// Centered modal. Used for both the socials editor and the link-campaign
// picker — both want focus, a backdrop, and an ESC/click-outside close.
function Modal({ onClose, title, children }) {
  const ref = useRef(null)
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4"
      onClick={e => { if (e.target === ref.current) onClose() }}
      ref={ref}
    >
      <div className="bg-card rounded-xl shadow-xl border border-rule w-full max-w-lg max-h-[80vh] overflow-y-auto">
        <div className="flex items-center justify-between px-4 py-3 border-b border-rule">
          <h3 className="text-sm font-bold text-gray-900">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700"><X size={16} /></button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  )
}
