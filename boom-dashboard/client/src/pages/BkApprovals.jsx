import { useState, useEffect, useMemo, useCallback, Fragment } from 'react'
import { Link } from 'react-router-dom'
import { Loader, AlertCircle, CheckCircle2, XCircle, Plus, Trash2, Search, FileText, File, AlertTriangle, Pencil, Save, X, Link2, Zap, Archive, Paperclip } from 'lucide-react'
import FilePreview from '../components/FilePreview'
import FlagButton from '../components/FlagButton'
import SearchableSelect from '../components/SearchableSelect'
import EmailPreviewModal from '../components/EmailPreviewModal'
import ApprovalChecklistDeck from '../components/ApprovalChecklistDeck'
import W9ReviewDeck from '../components/W9ReviewDeck'
import api from '../api'
import { useFxRates } from '../context/FxRatesContext'
import { usdSuffixForEntry, familyArtists } from '../utils'
import useHotkeys from '../hooks/useHotkeys'
import useIsMobile from '../hooks/useIsMobile'
import getDarkColors from '../utils/darkColors'
import { useTheme } from '../context/ThemeContext'
import { useAuth } from '../context/AuthContext'
import { CATEGORIES, CURRENCIES, PAYMENT_METHODS, SOCIAL_PLATFORMS } from '../constants'
import { useCategories } from '../context/CategoriesContext'
import { useBoomReps } from '../context/BoomRepsContext'

const RED = '#334155'
const GREEN = '#16a34a'
// Filter dropdowns prepend an "All" sentinel — FILTER_REPS is built
// dynamically inside the component now that BOOM_REPS is admin-curated.
const SORT_OPTIONS = ['Newest first', 'Oldest first', 'Amount: high', 'Amount: low']

function formatMoney(amount, currency = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: currency || 'USD'
  }).format(amount || 0)
}

// Detects the synthetic "no document was attached" discrepancies the AI
// occasionally fabricates — field names like "form_document" or values like
// "No form image was provided". Callers gate on whether the entry actually
// has the file: if it does and the AI claims it doesn't, suppress; if it
// really doesn't, show. Summaries are intentionally not filtered — they
// often contain useful info ("Document is a bank statement, not a W-9").
function isMissingDocClaim(d) {
  const field = String(d?.field || '').toLowerCase()
  const valueText = `${d?.form_value || ''} ${d?.document_value || ''} ${d?.w9_value || ''}`.toLowerCase()
  const fieldLooksSynthetic = /\b(form|document|image|attachment|tax[_ ]?form)[_ ]?(document|attached|present|provided|missing)?\b/.test(field) && !/(name|amount|address|email|invoice[_ ]?number|date|currency|tin|signature|signed|dated)/.test(field)
  const valueIndicatesMissing = /no\s+(form|document|image|invoice|receipt|tax[- ]?form|w[- ]?[89])/.test(valueText) || /not\s+(attached|provided|present|available|submitted)/.test(valueText) || /missing\s+(form|document|image|invoice|receipt)/.test(valueText)
  return fieldLooksSynthetic || valueIndicatesMissing
}


function fmtDate(d) {
  if (!d) return '—'
  return String(d).slice(0, 10)
}

function Avatar({ name }) {
  const letter = (name || '?')[0].toUpperCase()
  const colors = {
    A: '#334155', B: '#2563eb', C: '#16a34a', D: '#dc2626', E: '#7c3aed',
    F: '#ea580c', G: '#0891b2', H: '#4f46e5', I: '#be185d', J: '#ca8a04',
    K: '#15803d', L: '#9333ea', M: '#e11d48', N: '#0d9488', O: '#c2410c',
    P: '#7c2d12', Q: '#6d28d9', R: '#b91c1c', S: '#0369a1', T: '#a16207',
    U: '#059669', V: '#9333ea', W: '#db2777', X: '#4338ca', Y: '#65a30d', Z: '#334155',
  }
  const bg = colors[letter] || '#6b7280'
  return (
    <div style={{
      width: 36, height: 36, borderRadius: '50%', background: bg,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: '#fff', fontSize: 15, fontWeight: 800, flexShrink: 0,
    }}>
      {letter}
    </div>
  )
}

function FileChip({ filename, hasFile, type, entryId, onPreview, theme }) {
  // Render if we have either a filename or a signal that the file exists
  // (has_invoice / has_w9) — historic rows sometimes carry bytes without a
  // stored filename. (Re-applied from 2302a75; a page rollback reverted it.)
  if (!filename && !hasFile) return null
  const C = getDarkColors(theme)
  const isInvoice = type === 'invoice'
  const Icon = isInvoice ? FileText : File
  const displayName = filename || (isInvoice ? 'Invoice' : 'W9')
  const label = displayName.length > 30 ? displayName.slice(0, 27) + '...' : displayName
  const url = `/api/bk/entries/${entryId}/file/${type}?token=${localStorage.getItem('token')}`
  return (
    <button
      onClick={() => onPreview ? onPreview(url, filename) : window.open(url, '_blank')}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        background: C.elevBg, border: '1px solid ' + C.border, borderRadius: 6,
        padding: '4px 10px', fontSize: 12, color: C.text, whiteSpace: 'nowrap',
        cursor: 'pointer', transition: 'all 0.15s', fontFamily: 'inherit',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = C.rowHover; e.currentTarget.style.borderColor = '#ccc' }}
      onMouseLeave={e => { e.currentTarget.style.background = C.elevBg; e.currentTarget.style.borderColor = C.border }}
    >
      <Icon style={{ width: 13, height: 13, color: isInvoice ? '#b45309' : '#6b7280' }} />
      {label}
    </button>
  )
}

/**
 * A file the VENDOR attached alongside their invoice — the "Additional Files"
 * box on the submit form. Separate from FileChip because these are not the
 * invoice or the W9: they live in entity_files, are addressed by their own id,
 * and there can be several.
 *
 * Approvals is where a vendor submission is first read, so an attachment that
 * does not render here is one nobody sees at the moment it matters.
 */
function AttachmentChip({ attachment, entryId, onPreview, theme }) {
  const C = getDarkColors(theme)
  const name = attachment.name || 'Attachment'
  const label = name.length > 24 ? name.slice(0, 21) + '...' : name
  const url = `/api/bk/entries/${entryId}/receipts/${attachment.id}?token=${localStorage.getItem('token')}`
  return (
    <button
      onClick={() => onPreview ? onPreview(url, name) : window.open(url, '_blank')}
      title={`Sent by the vendor with this invoice — ${name}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        background: C.elevBg, border: '1px dashed ' + C.border, borderRadius: 6,
        padding: '4px 10px', fontSize: 12, color: C.text, whiteSpace: 'nowrap',
        cursor: 'pointer', transition: 'all 0.15s', fontFamily: 'inherit',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = C.rowHover; e.currentTarget.style.borderColor = '#ccc' }}
      onMouseLeave={e => { e.currentTarget.style.background = C.elevBg; e.currentTarget.style.borderColor = C.border }}
    >
      <Paperclip style={{ width: 13, height: 13, color: '#6b7280' }} />
      {label}
    </button>
  )
}

export default function BkApprovals() {
  const { rates: fxRates } = useFxRates()
  const { theme } = useTheme()
  const BOOM_REPS = useBoomReps()
  const FILTER_REPS = ['All reps', ...BOOM_REPS]
  // Same reason FILTER_REPS moved in here: the vocabulary is curated at
  // runtime now, so the sentinel list has to be built from the hook.
  const CATEGORIES = useCategories()
  const FILTER_CATEGORIES = ['All categories', ...CATEGORIES]
  const C = getDarkColors(theme)
  const selectSty = {
    background: C.inputBg, border: '1.5px solid ' + C.inputBorder, borderRadius: 8,
    padding: '8px 12px', color: C.text, fontSize: 13, fontFamily: 'inherit',
    outline: 'none', cursor: 'pointer', appearance: 'none',
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
    backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center',
    paddingRight: 28,
  }
  const inputSty = {
    background: C.inputBg, border: '1.5px solid ' + C.inputBorder, borderRadius: 8,
    padding: '8px 12px 8px 36px', color: C.text, fontSize: 13, fontFamily: 'inherit',
    outline: 'none', width: 260,
  }
  // Mobile (<768px): this page is inline-styled, so Tailwind breakpoints
  // don't reach it — sizing tweaks below key off this flag instead. The
  // card layout itself already stacks; only the toolbar and the button
  // rows need help.
  const isMobileView = useIsMobile()
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [selectedIds, setSelectedIds] = useState(new Set())
  // Queue of vendor-facing emails awaiting review. Filled by approve / reject
  // / bulk-approve when the server returns a pending_email[s] payload. Each
  // entry is shown via EmailPreviewModal; Send/Skip/Cancel advances to next.
  const [emailQueue, setEmailQueue] = useState([])
  // ── The W9 review, the SECOND review on this page ──
  // Its queue is a different SET from the invoice one: one card per W9
  // DOCUMENT, not per invoice, because 12 of the 13 pending invoices without
  // their own W9 are covered by one their vendor filed on another row.
  const [w9Queue, setW9Queue] = useState([])
  const [w9Deck, setW9Deck] = useState(false)
  const loadW9Queue = useCallback(async () => {
    try {
      const r = await api.get('/bk/w9-reviews')
      setW9Queue(r.data?.data?.queue || [])
    } catch { /* the page still works without it */ }
  }, [])
  useEffect(() => { loadW9Queue() }, [loadW9Queue])

  // Entry ids currently being reviewed in the checklist deck. Null = closed.
  const [deckIds, setDeckIds] = useState(null)
  const [teamRoster, setTeamRoster] = useState([])
  useEffect(() => {
    api.get('/team').then(r => {
      const list = Array.isArray(r.data?.data) ? r.data.data : (Array.isArray(r.data) ? r.data : [])
      setTeamRoster(list.filter(u => u && u.email))
    }).catch(() => {})
  }, [])
  const advanceQueue = () => setEmailQueue(q => q.slice(1))
  const [showArtistBreakdown, setShowArtistBreakdown] = useState({})
  const [artistBreakdown, setArtistBreakdown] = useState({})
  const [processingId, setProcessingId] = useState(null)
  const [rejectReason, setRejectReason] = useState({})
  const [rejectingId, setRejectingId] = useState(null) // which entry has the reject form open
  const [notifyVendor, setNotifyVendor] = useState({}) // per-entry: whether to email vendor
  const [expandedDesc, setExpandedDesc] = useState({})
  const [previewFile, setPreviewFile] = useState(null)
  const [focusedIdx, setFocusedIdx] = useState(-1)
  const [showAuditTrail, setShowAuditTrail] = useState(false)
  const [auditTrail, setAuditTrail] = useState([])
  const [editingId, setEditingId] = useState(null)
  const [editForm, setEditForm] = useState({})
  const [savingEdit, setSavingEdit] = useState(false)
  const [aliasPanelId, setAliasPanelId] = useState(null)
  const [aliasesByPayee, setAliasesByPayee] = useState({})
  const [newAliasText, setNewAliasText] = useState('')
  const [linkToVendor, setLinkToVendor] = useState('')
  const [allVendors, setAllVendors] = useState([])
  const [aliasSaving, setAliasSaving] = useState(false)

  const { user } = useAuth()
  // "isAdmin" here is actually the approve/reject gate — the Approver semi-
  // admin role can also use these buttons. Kept the variable name to avoid
  // touching every call-site; the three server endpoints use canApprove().
  const isAdmin = user?.role === 'Admin' || user?.role === 'Superadmin' || user?.role === 'Approver'

  const fetchAuditTrail = async () => {
    try {
      const res = await api.get('/bk/approval-history')
      setAuditTrail(res.data.data || [])
    } catch { setAuditTrail([]) }
  }

  useHotkeys([
    { key: 'j', handler: () => setFocusedIdx(i => Math.min(i + 1, filtered.length - 1)) },
    { key: 'k', handler: () => setFocusedIdx(i => Math.max(i - 1, 0)) },
    { key: 'a', handler: () => { if (focusedIdx >= 0 && focusedIdx < filtered.length) handleApprove(filtered[focusedIdx].id) } },
    { key: 'r', handler: () => { if (focusedIdx >= 0 && focusedIdx < filtered.length) setRejectingId(filtered[focusedIdx].id) } },
    { key: 'a', shift: true, handler: () => {
      // No confirm dialog any more: this opens the checklist deck, which is a
      // far better prompt than "are you sure?" — nothing is approved until each
      // card is answered, so a stray Shift+A now costs a keystroke, not money.
      if (filtered.length === 0) return
      handleBulkApprove(new Set(filtered.map(e => e.id)))
    } },
  ])

  // Filters
  const [search, setSearch] = useState('')
  const [repFilter, setRepFilter] = useState('All reps')
  const [catFilter, setCatFilter] = useState('All categories')
  const [sortBy, setSortBy] = useState('Newest first')

  const fetchApprovals = async () => {
    try {
      setLoading(true)
      setError('')
      const res = await api.get('/bk/approvals')
      setEntries(res.data.data || [])
    } catch (err) {
      setError('Failed to load approvals: ' + (err.response?.data?.error || err.message))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchApprovals() }, [])
  useEffect(() => {
    api.get('/bk/vendors').then(r => setAllVendors((r.data.data || []).map(v => v.payee).filter(Boolean))).catch(() => {})
  }, [])

  // Seed the per-entry artistBreakdown / showArtistBreakdown state from each
  // entry's `artist_breakdown` JSONB column. The endpoint returns it via
  // EXPENSE_LIGHT_COLS, but the local state was previously initialized empty
  // — so vendor-submitted multi-artist invoices (and any admin-saved splits
  // from a prior session) rendered the "Artist Breakdown" panel with only
  // an "Add row" button. Only seed rows the user hasn't already started
  // editing in this session, and only flip showArtistBreakdown ON, never
  // OFF, so manual collapses by the user stay collapsed.
  useEffect(() => {
    if (!entries.length) return
    setArtistBreakdown(prev => {
      const next = { ...prev }
      for (const e of entries) {
        if (next[e.id] !== undefined) continue // user is editing — leave alone
        const ab = e.artist_breakdown
        if (Array.isArray(ab) && ab.length > 0) {
          next[e.id] = ab.map(r => ({
            artist: r?.artist || '',
            song:   r?.song   || '',
            amount: r?.amount != null ? String(r.amount) : '',
          }))
        }
      }
      return next
    })
    setShowArtistBreakdown(prev => {
      const next = { ...prev }
      for (const e of entries) {
        if (next[e.id]) continue
        const ab = e.artist_breakdown
        if (Array.isArray(ab) && ab.length > 0) next[e.id] = true
      }
      return next
    })
  }, [entries])

  const openAliasPanel = async (payee) => {
    setAliasPanelId(payee)
    setNewAliasText('')
    setLinkToVendor('')
    try {
      const r = await api.get(`/bk/vendors/aliases/${encodeURIComponent(payee)}`)
      setAliasesByPayee(prev => ({ ...prev, [payee]: r.data.data || [] }))
    } catch { setAliasesByPayee(prev => ({ ...prev, [payee]: [] })) }
  }
  const closeAliasPanel = () => { setAliasPanelId(null); setNewAliasText(''); setLinkToVendor('') }
  const refreshAliases = async (payee) => {
    try {
      const r = await api.get(`/bk/vendors/aliases/${encodeURIComponent(payee)}`)
      setAliasesByPayee(prev => ({ ...prev, [payee]: r.data.data || [] }))
    } catch {}
  }
  const addAliasForPayee = async (payee) => {
    const alias = newAliasText.trim()
    if (!alias) return
    setAliasSaving(true)
    try {
      await api.post('/bk/vendors/aliases', { primary_name: payee, alias })
      setNewAliasText('')
      // Refresh aliases for the panel and re-fetch approvals so the server's
      // alias filter strips any now-resolved name discrepancies.
      await Promise.all([refreshAliases(payee), fetchApprovals()])
      setToast(`Added alias "${alias}"`); setTimeout(() => setToast(''), 3000)
    } catch (err) {
      setError('Failed to add alias: ' + (err.response?.data?.error || err.message))
    } finally { setAliasSaving(false) }
  }
  const linkPayeeToVendor = async (payee, primary) => {
    if (!primary || primary.toLowerCase() === (payee || '').toLowerCase()) return
    setAliasSaving(true)
    try {
      await api.post('/bk/vendors/aliases', { primary_name: primary, alias: payee })
      await fetchApprovals()
      setToast(`Linked "${payee}" as alias of "${primary}"`); setTimeout(() => setToast(''), 3000)
      closeAliasPanel()
    } catch (err) {
      setError('Failed to link: ' + (err.response?.data?.error || err.message))
    } finally { setAliasSaving(false) }
  }
  const removeAliasById = async (id, payee) => {
    try {
      await api.delete(`/bk/vendors/aliases/${id}`)
      await Promise.all([refreshAliases(payee), fetchApprovals()])
    } catch {}
  }

  const dismissScan = async (entryId, type) => {
    try {
      await api.post(`/bk/entries/${entryId}/dismiss-scan`, { type })
      const col = type === 'w9' ? 'w9_scan' : 'ai_scan'
      setEntries(prev => prev.map(e => e.id === entryId ? { ...e, [col]: null } : e))
    } catch (err) {
      setError('Failed to dismiss: ' + (err.response?.data?.error || err.message))
    }
  }

  const dismissDiscrepancy = async (entryId, type, discrepancy) => {
    const col = type === 'w9' ? 'w9_scan' : 'ai_scan'
    // Optimistic update — remove matching item immediately
    setEntries(prev => prev.map(e => {
      if (e.id !== entryId || !e[col]) return e
      const updated = {
        ...e[col],
        discrepancies: e[col].discrepancies.filter(d =>
          !(d.field === discrepancy.field &&
            d.form_value === discrepancy.form_value &&
            d.document_value === discrepancy.document_value)
        )
      }
      return { ...e, [col]: updated }
    }))
    try {
      const res = await api.post(`/bk/entries/${entryId}/dismiss-scan`, { type, discrepancy })
      if (res.data.scan !== undefined) {
        setEntries(prev => prev.map(e => e.id === entryId ? { ...e, [col]: res.data.scan } : e))
      }
    } catch (err) {
      setError('Failed to dismiss: ' + (err.response?.data?.error || err.message))
    }
  }

  const [rescanningId, setRescanningId] = useState(null)
  const rescanEntry = async (entryId, type) => {
    setRescanningId(`${entryId}:${type}`)
    setError('')
    try {
      const res = await api.post(`/bk/entries/${entryId}/rescan`, { types: [type] })
      const fresh = res.data?.data || {}
      const warnings = res.data?.warnings || []
      const col = type === 'w9' ? 'w9_scan' : 'ai_scan'
      if (fresh[col]) {
        setEntries(prev => prev.map(e => e.id === entryId ? { ...e, [col]: fresh[col] } : e))
        const ndis = fresh[col]?.discrepancies?.length || 0
        setToast(`AI ${type === 'w9' ? 'W9' : 'invoice'} scan refreshed — ${ndis} discrepanc${ndis === 1 ? 'y' : 'ies'} found.`)
      } else if (warnings.length) {
        // Server returned 200 but couldn't actually rescan — surface why so the
        // user knows the click didn't silently succeed.
        setError('Re-scan: ' + warnings.join(' / '))
      } else {
        setError('Re-scan returned no result. Check server logs for details.')
      }
      setTimeout(() => setToast(''), 4000)
    } catch (err) {
      setError('Re-scan failed: ' + (err.response?.data?.error || err.message))
    } finally {
      setRescanningId(null)
    }
  }

  // Flag-for-review — mirrors BkLedger's toggle. Optimistic update, roll back
  // on failure by refetching from the server. Popover lives in the shared
  // FlagButton component, portaled to <body> so the Approvals row can't clip it.
  const toggleFlag = async (entryId, nextFlagged, reason = null) => {
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
      setError(`Couldn't ${nextFlagged ? 'flag' : 'unflag'} entry: ${err?.response?.data?.error || err.message}`)
    }
  }
  const saveFlagReason = async (entryId, reason) => {
    setEntries(prev => prev.map(e => e.id === entryId ? { ...e, flag_reason: reason || null } : e))
    try {
      await api.post(`/bk/entries/${entryId}/flag`, { flagged: true, flag_reason: reason || '' })
    } catch (err) {
      setError(`Couldn't save reason: ${err?.response?.data?.error || err.message}`)
    }
  }

  // Rush toggle — same shape as toggleFlag but hits the payments/:id/rush
  // endpoints already in use on the Payment Dashboard. Mutually exclusive
  // with on_hold; the server clears any existing hold when rush is set,
  // so we mirror that locally too.
  const toggleRush = async (entryId, nextRush, reason = null) => {
    setEntries(prev => prev.map(e => e.id === entryId ? {
      ...e,
      rush_requested: nextRush,
      rush_reason: nextRush ? (reason ?? e.rush_reason ?? null) : null,
      rush_requested_at: nextRush ? new Date().toISOString() : null,
      rush_requested_by: nextRush ? (user?.name || 'You') : null,
      // Rush ↔ hold mutex, mirrored client-side so the badge state
      // doesn't lie about what the server just did.
      ...(nextRush ? { on_hold: false, hold_at: null, hold_by: null, hold_reason: null } : {}),
    } : e))
    try {
      if (nextRush) {
        const { data } = await api.post(`/bk/payments/${entryId}/rush`, { reason: reason || '' })
        if (data?.data) {
          setEntries(prev => prev.map(e => e.id === entryId ? { ...e, ...data.data } : e))
        }
      } else {
        const { data } = await api.delete(`/bk/payments/${entryId}/rush`)
        if (data?.data) {
          setEntries(prev => prev.map(e => e.id === entryId ? { ...e, ...data.data } : e))
        }
      }
    } catch (err) {
      setError(`Couldn't ${nextRush ? 'set' : 'clear'} rush: ${err?.response?.data?.error || err.message}`)
    }
  }

  // Apply a one-click "use suggestion" fix for unknown_artist / unknown_song.
  // PUTs the corrected field, then clears the matching flag in local state so
  // the alert disappears immediately. For songs, also writes release_id when
  // we have one — auto-links the entry to the catalog row.
  const applyArtistSuggestion = async (entryId, newName) => {
    try {
      await api.put(`/bk/entries/${entryId}`, { artist: newName })
      setEntries(prev => prev.map(e => e.id === entryId ? {
        ...e, artist: newName,
        unknown_artist: false, suggested_artist_id: null, suggested_artist_name: null,
      } : e))
      setToast(`Artist set to "${newName}"`); setTimeout(() => setToast(''), 3000)
    } catch (err) {
      setError('Failed to update artist: ' + (err.response?.data?.error || err.message))
    }
  }
  const applySongSuggestion = async (entryId, newName, releaseId) => {
    try {
      const body = { song: newName }
      if (releaseId) body.release_id = releaseId
      await api.put(`/bk/entries/${entryId}`, body)
      setEntries(prev => prev.map(e => e.id === entryId ? {
        ...e, song: newName,
        release_id: releaseId || e.release_id,
        unknown_song: false, suggested_release_id: null, suggested_song_name: null, suggested_release_artist: null,
      } : e))
      setToast(`Song set to "${newName}"`); setTimeout(() => setToast(''), 3000)
    } catch (err) {
      setError('Failed to update song: ' + (err.response?.data?.error || err.message))
    }
  }

  // Format an ISO timestamp as "2m ago" / "just now" so the rescan banner can
  // show evidence the scan actually ran when the AI's response is similar to
  // the previous one (otherwise the click looks like it did nothing).
  function relativeAgo(iso) {
    if (!iso) return null
    const ms = Date.now() - new Date(iso).getTime()
    if (Number.isNaN(ms) || ms < 0) return null
    const m = Math.floor(ms / 60000)
    if (m < 1) return 'just now'
    if (m < 60) return `${m}m ago`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h ago`
    return `${Math.floor(h / 24)}d ago`
  }

  const filtered = useMemo(() => {
    let list = [...entries]
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(e =>
        (e.payee || '').toLowerCase().includes(q) ||
        (e.artist || '').toLowerCase().includes(q) ||
        (e.vendor_name || '').toLowerCase().includes(q) ||
        (e.invoice_number || '').toLowerCase().includes(q) ||
        (e.description || '').toLowerCase().includes(q)
      )
    }
    if (repFilter !== 'All reps') list = list.filter(e => e.boom_rep === repFilter)
    if (catFilter !== 'All categories') list = list.filter(e => e.category === catFilter)
    if (sortBy === 'Newest first') list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    else if (sortBy === 'Oldest first') list.sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    else if (sortBy === 'Amount: high') list.sort((a, b) => (b.amount || 0) - (a.amount || 0))
    else if (sortBy === 'Amount: low') list.sort((a, b) => (a.amount || 0) - (b.amount || 0))
    return list
  }, [entries, search, repFilter, catFilter, sortBy])

  const handleToggleSelect = (id) => {
    const s = new Set(selectedIds)
    if (s.has(id)) s.delete(id); else s.add(id)
    setSelectedIds(s)
  }

  const handleSelectAll = () => {
    if (selectedIds.size === filtered.length) setSelectedIds(new Set())
    else setSelectedIds(new Set(filtered.map(e => e.id)))
  }

  // Every approve entry point — the row button, `a`, Approve All, Approve N,
  // Shift+A — opens the checklist deck instead of approving. Routing them all
  // through these two functions is deliberate: a bypass anywhere makes the
  // checklist optional in practice, and this way there is no path to add.
  //
  // The server refuses an approval without a complete checklist regardless
  // (validateApprovalChecklist in routes/bookkeeping.js), so this is the
  // convenient way in, not the enforcement.
  const handleApprove = (entryId) => setDeckIds([entryId])

  const handleBulkApprove = (overrideIds) => {
    const ids = overrideIds instanceof Set ? overrideIds : selectedIds
    if (ids.size === 0) return
    setDeckIds(Array.from(ids))
  }

  // One invoice approved inside the deck: drop it from the page and queue any
  // vendor email. APPENDING matters — the deck can approve 24 in a row, and a
  // composer that opened per card would fight the deck, so the queue is drained
  // after it closes.
  const handleDeckApproved = (entry, pendingEmail) => {
    setEntries(prev => prev.filter(e => e.id !== entry.id))
    setSelectedIds(prev => { const n = new Set(prev); n.delete(entry.id); return n })
    setShowArtistBreakdown(prev => { const c = { ...prev }; delete c[entry.id]; return c })
    if (pendingEmail) setEmailQueue(q => [...q, pendingEmail])
  }

  // A field fixed inside the deck — keep the page's copy in step so closing the
  // deck doesn't reveal stale values.
  const handleDeckPatched = (entryId, patch) => {
    setEntries(prev => prev.map(e => e.id === entryId ? { ...e, ...patch } : e))
  }

  const handleReject = async (entryId) => {
    const reason = (rejectReason[entryId] || '').trim()
    if (!reason) return
    const notify = notifyVendor[entryId] ?? false
    try {
      setProcessingId(entryId)
      const r = await api.post(`/bk/entries/${entryId}/reject`, { reason, notify })
      setEntries(prev => prev.filter(e => e.id !== entryId))
      setSelectedIds(prev => { const n = new Set(prev); n.delete(entryId); return n })
      const pe = r.data?.pending_email
      if (pe) {
        setEmailQueue(q => [...q, pe])
      } else {
        setToast(notify ? 'Entry rejected' : 'Entry rejected (vendor not notified)')
        setTimeout(() => setToast(''), 3000)
      }
    } catch (err) {
      setError('Failed to reject: ' + (err.response?.data?.error || err.message))
    } finally {
      setProcessingId(null)
    }
  }

  // Open the rejection-reason form for an entry and pre-check "notify vendor"
  // (only when no explicit choice has been made yet) — silent rejects are
  // almost always a mistake.
  const openRejectForm = (entry) => {
    if (rejectingId === entry.id) { setRejectingId(null); return }
    setRejectingId(entry.id)
    if (entry.vendor_submitted && entry.vendor_email && notifyVendor[entry.id] === undefined) {
      setNotifyVendor(prev => ({ ...prev, [entry.id]: true }))
    }
  }

  const addArtistRow = (entryId) => {
    const current = artistBreakdown[entryId] || []
    setArtistBreakdown(prev => ({ ...prev, [entryId]: [...current, { artist: '', song: '', amount: '' }] }))
  }
  const updateArtistRow = (entryId, idx, field, value) => {
    const current = [...(artistBreakdown[entryId] || [])]
    current[idx] = { ...current[idx], [field]: value }
    setArtistBreakdown(prev => ({ ...prev, [entryId]: current }))
  }
  const removeArtistRow = (entryId, idx) => {
    setArtistBreakdown(prev => ({ ...prev, [entryId]: (prev[entryId] || []).filter((_, i) => i !== idx) }))
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
      description: entry.description || '',
      boom_rep: entry.boom_rep || '',
      currency: entry.currency || 'USD',
      vendor_email: entry.vendor_email || '',
      payment_method: entry.payment_method || '',
      notes: entry.notes || '',
      // Normalize social_handles into the same [{ platform, handle }] shape
      // VendorSubmit collects. Stays an empty array when the entry has none
      // so the "+ Add" affordance can stand alone.
      social_handles: Array.isArray(entry.social_handles)
        ? entry.social_handles.map(s => ({ platform: s?.platform || 'Instagram', handle: s?.handle || '', artist: s?.artist || '', amount: s?.amount ?? '' }))
        : [],
    })
  }

  const cancelEdit = () => { setEditingId(null); setEditForm({}) }

  // Inline category save — quick edit without opening the full Edit modal.
  // Optimistic; rolls back on failure. No-ops when the value didn't change so
  // tabbing through the select doesn't fire spurious saves.
  const saveCategory = async (entryId, newCategory) => {
    const prev = entries.find(e => e.id === entryId)?.category ?? ''
    if ((newCategory || '') === (prev || '')) return
    setEntries(es => es.map(e => e.id === entryId ? { ...e, category: newCategory || null } : e))
    try {
      await api.put(`/bk/entries/${entryId}`, { category: newCategory || null })
      setToast('Category updated')
      setTimeout(() => setToast(''), 2000)
    } catch (err) {
      setEntries(es => es.map(e => e.id === entryId ? { ...e, category: prev } : e))
      setError('Failed to update category: ' + (err.response?.data?.error || err.message))
    }
  }

  const saveEdit = async (entryId) => {
    const trimmedEmail = (editForm.vendor_email || '').trim()
    if (trimmedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setError('Please enter a valid vendor email address.')
      return
    }
    // Number('') === 0 — a cleared Amount silently zeroed the invoice.
    const amtCheck = Number(editForm.amount)
    if (!Number.isFinite(amtCheck) || amtCheck <= 0) {
      setError('Amount must be a number greater than zero.')
      return
    }
    setSavingEdit(true)
    try {
      // Strip empty social rows on save — only ship handles the user filled in.
      const cleanedSocials = Array.isArray(editForm.social_handles)
        ? editForm.social_handles
            .map(s => {
              const platform = (s.platform || 'Instagram').trim()
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
        : []
      const res = await api.put(`/bk/entries/${entryId}`, {
        payee: editForm.payee,
        artist: editForm.artist,
        song: editForm.song,
        amount: Number(editForm.amount),
        invoice_date: editForm.invoice_date || null,
        invoice_number: editForm.invoice_number,
        category: editForm.category,
        description: editForm.description,
        boom_rep: editForm.boom_rep,
        currency: editForm.currency,
        vendor_email: trimmedEmail || null,
        payment_method: editForm.payment_method || null,
        notes: editForm.notes || null,
        social_handles: cleanedSocials,
      })
      // Server returns fresh ai_scan/w9_scan if discrepancy-relevant fields changed.
      // Merge the server row onto the existing entry so we keep fields the PUT didn't return.
      const fresh = res.data?.data || {}
      setEntries(prev => prev.map(e => e.id === entryId
        ? { ...e, ...editForm, amount: Number(editForm.amount), vendor_email: trimmedEmail || null, social_handles: cleanedSocials, ai_scan: fresh.ai_scan ?? e.ai_scan, w9_scan: fresh.w9_scan ?? e.w9_scan }
        : e))
      setEditingId(null)
      setEditForm({})
      setToast('Entry updated')
      setTimeout(() => setToast(''), 3000)
    } catch (err) {
      setError('Failed to save: ' + (err.response?.data?.error || err.message))
    } finally { setSavingEdit(false) }
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '24rem' }}>
        <div style={{ textAlign: 'center' }}>
          <Loader style={{ width: 28, height: 28, color: RED, margin: '0 auto 8px', animation: 'spin 0.8s linear infinite' }} />
          <p style={{ color: '#777', fontSize: 14 }}>Loading approvals…</p>
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100%', background: C.pageBg }}>
      <div style={{ maxWidth: 1060, margin: '0 auto', padding: isMobileView ? '16px 12px 80px' : '32px 24px' }}>

        {/* ── Header ── */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
            <h1 style={{ fontSize: 26, fontWeight: 800, color: C.text, margin: 0 }}>Pending Approvals</h1>
            <span style={{
              background: '#d1fae5', color: '#065f46', fontSize: 13, fontWeight: 700,
              padding: '2px 10px', borderRadius: 20,
            }}>
              {entries.length}
            </span>
            {/* Jump to the archive of rejected + soft-deleted invoices.
                Admin-only (strict — Approver excluded): the archive page
                and its deleted-rows feed are gated to Admin/Superadmin. */}
            {['Admin', 'Superadmin'].includes(user?.role) && (
            <Link
              to="/bk/approvals/archive"
              style={{
                marginLeft: 'auto',
                display: 'inline-flex', alignItems: 'center', gap: 6,
                background: 'transparent', border: `1px solid ${C.border}`,
                color: '#6b7280', fontSize: 12, fontWeight: 600,
                padding: '5px 12px', borderRadius: 8,
                textDecoration: 'none', fontFamily: 'inherit',
                transition: 'all 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.color = C.text; e.currentTarget.style.borderColor = C.textMuted }}
              onMouseLeave={e => { e.currentTarget.style.color = '#6b7280'; e.currentTarget.style.borderColor = C.border }}
              title="View rejected and soft-deleted invoices"
            >
              <Archive size={12} /> Archive
            </Link>
            )}
          </div>
          <p style={{ color: '#888', fontSize: 14, margin: 0 }}>
            Review vendor-submitted invoices before they appear in the ledger.
          </p>
        </div>

        {/* ── Toolbar ── */}
        <div style={{
          display: 'flex', gap: 10, alignItems: 'center', marginBottom: 20, flexWrap: 'wrap',
        }}>
          <div style={{ position: 'relative', ...(isMobileView ? { flex: '1 1 100%' } : null) }}>
            <Search style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', width: 15, height: 15, color: '#aaa' }} />
            <input
              type="text" placeholder="Search vendor, artist, invoice #..."
              value={search} onChange={e => setSearch(e.target.value)}
              style={{ ...inputSty, ...(isMobileView ? { width: '100%' } : null) }}
            />
          </div>
          <select style={{ ...selectSty, ...(isMobileView ? { flex: '1 1 44%', minWidth: 0 } : null) }} value={repFilter} onChange={e => setRepFilter(e.target.value)}>
            {FILTER_REPS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <select style={{ ...selectSty, ...(isMobileView ? { flex: '1 1 44%', minWidth: 0 } : null) }} value={catFilter} onChange={e => setCatFilter(e.target.value)}>
            {FILTER_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select style={{ ...selectSty, ...(isMobileView ? { flex: '1 1 44%', minWidth: 0 } : null) }} value={sortBy} onChange={e => setSortBy(e.target.value)}>
            {SORT_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <button
            onClick={() => { if (!showAuditTrail) fetchAuditTrail(); setShowAuditTrail(v => !v) }}
            style={{
              background: showAuditTrail ? 'rgba(51, 65, 85,.08)' : 'none',
              border: '1.5px solid ' + (showAuditTrail ? RED : C.border),
              borderRadius: 8, padding: '7px 14px', fontSize: 12, fontWeight: 600,
              fontFamily: 'inherit', cursor: 'pointer', color: showAuditTrail ? RED : C.textMuted,
              whiteSpace: 'nowrap',
            }}
          >
            Recent Activity
          </button>
          <span style={{ color: '#999', fontSize: 13, marginLeft: 'auto' }}>{filtered.length} pending</span>
          {filtered.length > 0 && (
            <button
              onClick={() => handleBulkApprove(new Set(filtered.map(e => e.id)))}
              disabled={processingId === 'bulk'}
              style={{
                background: GREEN, color: '#fff', border: 'none', borderRadius: 8,
                padding: '8px 16px', fontSize: 13, fontWeight: 700,
                fontFamily: 'inherit', cursor: 'pointer',
                opacity: processingId === 'bulk' ? 0.5 : 1,
                whiteSpace: 'nowrap',
              }}
            >
              Review all {filtered.length}
            </button>
          )}
          {w9Queue.length > 0 && (
            <button
              onClick={() => setW9Deck(true)}
              style={{
                background: 'transparent', color: '#6b7280', border: '1px solid #d1d5db',
                borderRadius: 8, padding: '8px 16px', fontSize: 13, fontWeight: 700,
                fontFamily: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap',
              }}
              title="Confirm each vendor's W9 is signed and dated. One card per document — reviewing once covers every invoice from that vendor."
            >
              Review W9s {w9Queue.length}
            </button>
          )}
        </div>

        {/* ── Audit trail ── */}
        {showAuditTrail && (
          <div style={{ background: C.cardBg, borderRadius: 10, border: '1px solid ' + C.border, marginBottom: 16, overflow: 'hidden' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid ' + C.border, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>Recent Approval Activity</span>
              <span style={{ fontSize: 11, color: C.textFaint }}>{auditTrail.length} actions</span>
            </div>
            <div style={{ maxHeight: 240, overflowY: 'auto' }}>
              {auditTrail.length === 0 ? (
                <div style={{ padding: 20, textAlign: 'center', fontSize: 13, color: C.textFaint }}>No approval activity yet</div>
              ) : auditTrail.map(a => (
                <div key={a.id} style={{ padding: '8px 16px', borderBottom: '1px solid ' + C.borderLight, display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 }}>
                  <div>
                    <span style={{ fontWeight: 700, color: C.text }}>{a.user_name}</span>
                    <span style={{ color: a.action.includes('reject') ? '#dc2626' : GREEN, fontWeight: 600, marginLeft: 8 }}>
                      {a.action === 'expense_approved' ? 'approved' : a.action === 'expense_approved_split' ? 'approved (split)' : a.action === 'expense_rejected' ? 'rejected' : a.action === 'bulk_approved' ? 'bulk approved' : a.action}
                    </span>
                    {a.entry_payee && <span style={{ color: C.textMuted, marginLeft: 8 }}>{a.entry_payee}</span>}
                    {a.details && <span style={{ color: C.textFaint, marginLeft: 6 }}>— {a.details}</span>}
                  </div>
                  <span style={{ color: C.textFaint, whiteSpace: 'nowrap', fontSize: 11 }}>
                    {new Date(a.ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} {new Date(a.ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Bulk bar ── */}
        {selectedIds.size > 0 && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px',
            background: C.cardBg, borderRadius: 10, border: '1.5px solid ' + C.border,
            marginBottom: 16,
          }}>
            <input
              type="checkbox" checked={selectedIds.size === filtered.length && filtered.length > 0}
              onChange={handleSelectAll}
              style={{ width: 16, height: 16, cursor: 'pointer', accentColor: RED }}
            />
            <span style={{ fontSize: 13, fontWeight: 600, color: '#555' }}>{selectedIds.size} selected</span>
            <button
              onClick={() => handleBulkApprove()}
              disabled={processingId === 'bulk'}
              style={{
                marginLeft: 'auto', background: GREEN, color: '#fff', border: 'none',
                borderRadius: 8, padding: '8px 18px', fontSize: 13, fontWeight: 700,
                fontFamily: 'inherit', cursor: 'pointer', opacity: processingId === 'bulk' ? 0.5 : 1,
              }}
            >
              {`Review ${selectedIds.size}`}
            </button>
          </div>
        )}

        {/* ── Error / Toast ── */}
        {error && (
          <div style={{ background: C.isDark ? '#2a1a1a' : '#fef2f2', border: '1px solid ' + (C.isDark ? '#5c2020' : '#fca5a5'), color: C.isDark ? '#fca5a5' : '#991b1b', padding: '10px 14px', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 16 }}>
            <AlertCircle style={{ width: 16, height: 16, flexShrink: 0 }} />
            {error}
            <button onClick={() => setError('')} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#991b1b', fontSize: 14, cursor: 'pointer' }}>✕</button>
          </div>
        )}
        {toast && (
          <div style={{ background: C.isDark ? '#1a2a1a' : '#f0fdf4', border: '1px solid ' + (C.isDark ? '#1a4a1a' : '#bbf7d0'), color: C.isDark ? '#86efac' : '#15803d', padding: '10px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600, marginBottom: 16 }}>
            {toast}
          </div>
        )}

        {/* ── Cards ── */}
        {filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '80px 20px', background: C.cardBg, borderRadius: 12, border: '1px solid ' + C.border }}>
            <CheckCircle2 style={{ width: 40, height: 40, color: GREEN, margin: '0 auto 12px' }} />
            <p style={{ color: '#777', fontSize: 15, fontWeight: 600 }}>
              {entries.length === 0 ? 'All invoices are approved!' : 'No matches for current filters.'}
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {filtered.map((entry, eIdx) => {
              const nameMismatch = entry.vendor_name && entry.payee &&
                entry.vendor_name.toLowerCase() !== entry.payee.toLowerCase() &&
                entry.vendor_submitted
              const desc = entry.description || ''
              const isLong = desc.length > 120
              const showFull = expandedDesc[entry.id]
              const isFocused = focusedIdx === eIdx

              return (
                <div key={entry.id} ref={isFocused ? el => el?.scrollIntoView({ block: 'nearest' }) : undefined} style={{
                  background: C.cardBg, borderRadius: 12, border: isFocused ? '2px solid #6366f1' : '1px solid ' + C.border,
                  overflow: 'hidden', boxShadow: isFocused ? '0 0 0 3px rgba(99,102,241,.15)' : undefined,
                }}>
                  {/* ── Card header ── */}
                  <div style={{ padding: '16px 20px 0' }}>
                    {editingId === entry.id ? (
                      /* ── Edit mode header ── */
                      <div>
                        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                          <div style={{ flex: 2 }}>
                            <label style={{ fontSize: 10, fontWeight: 700, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2, display: 'block' }}>Payee</label>
                            <input value={editForm.payee} onChange={e => setEditForm(f => ({ ...f, payee: e.target.value }))}
                              style={{ ...inputSty, paddingLeft: 10, width: '100%', fontWeight: 700 }} />
                          </div>
                          <div style={{ flex: 1 }}>
                            <label style={{ fontSize: 10, fontWeight: 700, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2, display: 'block' }}>Amount</label>
                            <input type="number" step="0.01" value={editForm.amount} onChange={e => setEditForm(f => ({ ...f, amount: e.target.value }))}
                              style={{ ...inputSty, paddingLeft: 10, width: '100%', fontWeight: 700 }} />
                          </div>
                          <div style={{ width: 90 }}>
                            <label style={{ fontSize: 10, fontWeight: 700, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2, display: 'block' }}>Currency</label>
                            <select value={editForm.currency} onChange={e => setEditForm(f => ({ ...f, currency: e.target.value }))}
                              style={{ ...selectSty, width: '100%' }}>
                              {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                            </select>
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                          <div style={{ flex: 1 }}>
                            <label style={{ fontSize: 10, fontWeight: 700, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2, display: 'block' }}>Artist</label>
                            <input value={editForm.artist} onChange={e => setEditForm(f => ({ ...f, artist: e.target.value }))}
                              style={{ ...inputSty, paddingLeft: 10, width: '100%' }} />
                          </div>
                          <div style={{ flex: 1 }}>
                            <label style={{ fontSize: 10, fontWeight: 700, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2, display: 'block' }}>Song</label>
                            <input value={editForm.song} onChange={e => setEditForm(f => ({ ...f, song: e.target.value }))}
                              style={{ ...inputSty, paddingLeft: 10, width: '100%' }} />
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                          <div style={{ flex: 1 }}>
                            <label style={{ fontSize: 10, fontWeight: 700, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2, display: 'block' }}>Date</label>
                            <input type="date" value={editForm.invoice_date} onChange={e => setEditForm(f => ({ ...f, invoice_date: e.target.value }))}
                              style={{ ...inputSty, paddingLeft: 10, width: '100%' }} />
                          </div>
                          <div style={{ flex: 1 }}>
                            <label style={{ fontSize: 10, fontWeight: 700, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2, display: 'block' }}>Invoice #</label>
                            <input value={editForm.invoice_number} onChange={e => setEditForm(f => ({ ...f, invoice_number: e.target.value }))}
                              style={{ ...inputSty, paddingLeft: 10, width: '100%' }} />
                          </div>
                          <div style={{ flex: 1 }}>
                            <label style={{ fontSize: 10, fontWeight: 700, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2, display: 'block' }}>Category</label>
                            <select value={editForm.category} onChange={e => setEditForm(f => ({ ...f, category: e.target.value }))}
                              style={{ ...selectSty, width: '100%' }}>
                              <option value="">—</option>
                              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                            </select>
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                          <div style={{ flex: 2 }}>
                            <label style={{ fontSize: 10, fontWeight: 700, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2, display: 'block' }}>Description</label>
                            <input value={editForm.description} onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))}
                              style={{ ...inputSty, paddingLeft: 10, width: '100%' }} />
                          </div>
                          <div style={{ flex: 1 }}>
                            <label style={{ fontSize: 10, fontWeight: 700, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2, display: 'block' }}>Market Street Rep</label>
                            <select value={editForm.boom_rep} onChange={e => setEditForm(f => ({ ...f, boom_rep: e.target.value }))}
                              style={{ ...selectSty, width: '100%' }}>
                              <option value="">—</option>
                              {BOOM_REPS.map(r => <option key={r} value={r}>{r}</option>)}
                            </select>
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                          <div style={{ flex: 2 }}>
                            <label style={{ fontSize: 10, fontWeight: 700, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2, display: 'block' }}>
                              Vendor Email <span style={{ color: C.textFaint, fontWeight: 500, textTransform: 'none', letterSpacing: 0 }}>— used for approval / rejection notifications</span>
                            </label>
                            <input type="email" value={editForm.vendor_email} onChange={e => setEditForm(f => ({ ...f, vendor_email: e.target.value }))}
                              placeholder="vendor@example.com"
                              style={{ ...inputSty, paddingLeft: 10, width: '100%' }} />
                          </div>
                          <div style={{ flex: 1 }}>
                            <label style={{ fontSize: 10, fontWeight: 700, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2, display: 'block' }}>Payment Method</label>
                            <select value={editForm.payment_method} onChange={e => setEditForm(f => ({ ...f, payment_method: e.target.value }))}
                              style={{ ...selectSty, width: '100%' }}>
                              <option value="">—</option>
                              {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                            </select>
                          </div>
                        </div>
                        {/* ── Socials ──
                            Optional list of social handles attached to the
                            entry. Stored as JSONB [{platform, handle}]. Same
                            shape vendor-submit collects; rendered here so
                            admins can edit/add missing handles during review.
                            Empty rows are stripped before save. */}
                        <div style={{ marginBottom: 8 }}>
                          <div style={{
                            border: '1px solid ' + C.inputBorder, borderRadius: 8,
                            padding: 10, background: C.inputBg,
                          }}>
                            <label style={{ fontSize: 10, fontWeight: 700, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 8 }}>
                              Socials <span style={{ color: C.textFaint, fontWeight: 500, textTransform: 'none', letterSpacing: 0 }}>— optional handles by platform</span>
                            </label>
                            {(editForm.social_handles || []).length === 0 && (
                              <div style={{ fontSize: 12, color: C.textFaint, marginBottom: 8 }}>
                                No socials yet. Add one below.
                              </div>
                            )}
                            {(() => {
                              // Compute this invoice's split family once
                              // so the "For artist" dropdown only surfaces
                              // when there's more than one artist to
                              // choose between.
                              const family = familyArtists(entry)
                              const hasSplit = family.length > 1
                              return (editForm.social_handles || []).map((row, i) => (
                              <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
                                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                <select
                                  value={row.platform || 'Instagram'}
                                  onChange={e => setEditForm(f => ({
                                    ...f,
                                    social_handles: (f.social_handles || []).map((r, idx) => idx === i ? { ...r, platform: e.target.value } : r),
                                  }))}
                                  style={{ ...selectSty, flex: '0 0 140px' }}
                                >
                                  {SOCIAL_PLATFORMS.map(p => <option key={p} value={p}>{p}</option>)}
                                </select>
                                <input
                                  type="text"
                                  value={row.handle || ''}
                                  onChange={e => setEditForm(f => ({
                                    ...f,
                                    social_handles: (f.social_handles || []).map((r, idx) => idx === i ? { ...r, handle: e.target.value } : r),
                                  }))}
                                  placeholder="@handle or url"
                                  style={{ ...inputSty, flex: 1, paddingLeft: 10, width: 'auto' }}
                                />
                                <input
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  value={row.amount || ''}
                                  onChange={e => setEditForm(f => ({
                                    ...f,
                                    social_handles: (f.social_handles || []).map((r, idx) => idx === i ? { ...r, amount: e.target.value } : r),
                                  }))}
                                  placeholder="$"
                                  title="Amount paid to this creator (optional)"
                                  style={{ ...inputSty, flex: '0 0 72px', width: 72, paddingLeft: 10 }}
                                />
                                <button
                                  type="button"
                                  onClick={() => setEditForm(f => ({
                                    ...f,
                                    social_handles: (f.social_handles || []).filter((_, idx) => idx !== i),
                                  }))}
                                  title="Remove"
                                  style={{
                                    background: 'transparent', border: 'none',
                                    color: C.textMuted, cursor: 'pointer',
                                    padding: 4, display: 'inline-flex', alignItems: 'center',
                                  }}
                                >
                                  <Trash2 size={14} />
                                </button>
                                </div>
                                {/* Split-only "For artist" tag. Empty
                                    means the handle is shared across
                                    every artist on the invoice. */}
                                {hasSplit && (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 4 }}>
                                    <span style={{ fontSize: 10, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 700, minWidth: 62 }}>For artist</span>
                                    <select
                                      value={row.artist || ''}
                                      onChange={e => setEditForm(f => ({
                                        ...f,
                                        social_handles: (f.social_handles || []).map((r, idx) => idx === i ? { ...r, artist: e.target.value } : r),
                                      }))}
                                      style={{ ...selectSty, flex: 1, minWidth: 0 }}
                                    >
                                      <option value="">All artists (untagged)</option>
                                      {family.map(a => <option key={a} value={a}>{a}</option>)}
                                    </select>
                                  </div>
                                )}
                              </div>
                            ))
                            })()}
                            <button
                              type="button"
                              disabled={false}
                              onClick={() => setEditForm(f => ({
                                ...f,
                                social_handles: [...(f.social_handles || []), { platform: 'Instagram', handle: '', artist: '', amount: '' }],
                              }))}
                              style={{
                                background: 'transparent',
                                border: '1px dashed ' + C.inputBorder,
                                color: C.text, borderRadius: 6, padding: '6px 10px',
                                fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
                                cursor: 'pointer',
                                opacity: 1,
                                display: 'inline-flex', alignItems: 'center', gap: 4,
                              }}
                            >
                              <Plus size={12} /> Add social
                            </button>
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                          <div style={{ flex: 1 }}>
                            <label style={{ fontSize: 10, fontWeight: 700, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2, display: 'block' }}>Notes</label>
                            <input type="text" value={editForm.notes} onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))}
                              placeholder="Internal notes — surfaced on the ledger and approvals card"
                              style={{ ...inputSty, paddingLeft: 10, width: '100%' }} />
                          </div>
                        </div>
                      </div>
                    ) : (
                      /* ── Normal header ── */
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(entry.id)}
                          onChange={() => handleToggleSelect(entry.id)}
                          style={{ width: 16, height: 16, cursor: 'pointer', accentColor: RED, marginTop: 10, flexShrink: 0 }}
                        />
                        <Avatar name={entry.payee} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <div style={{ fontWeight: 800, fontSize: 15, color: C.text }}>{entry.payee}</div>
                            {/* Flag-for-review chip — click to toggle,
                                popover for optional reason. Portaled to
                                <body> so the approval card's overflow can't
                                clip it. alwaysVisible so an unflagged row
                                still shows the outlined affordance. */}
                            <div onClick={e => e.stopPropagation()}>
                              <FlagButton
                                flagged={!!entry.flagged}
                                reason={entry.flag_reason || ''}
                                onToggle={(next, reason) => toggleFlag(entry.id, next, reason ?? null)}
                                onSaveReason={(reason) => saveFlagReason(entry.id, reason)}
                                size="sm"
                                alwaysVisible
                              />
                            </div>
                            {/* Rush toggle — click to arm (with an
                                optional reason prompt) or clear. Server
                                enforces the rush/hold mutex; local
                                state mirrors that in toggleRush. */}
                            <button
                              type="button"
                              onClick={e => {
                                e.stopPropagation()
                                if (entry.rush_requested) {
                                  toggleRush(entry.id, false)
                                  return
                                }
                                const reason = window.prompt(
                                  'Rush reason (optional) — will show on the Payment Dashboard for the AP team.',
                                  ''
                                )
                                if (reason === null) return // user cancelled the prompt
                                toggleRush(entry.id, true, reason.trim() || null)
                              }}
                              title={entry.rush_requested
                                ? `Rush requested${entry.rush_requested_by ? ` by ${entry.rush_requested_by}` : ''}${entry.rush_reason ? ` — ${entry.rush_reason}` : ''}. Click to clear.`
                                : 'Mark this invoice as RUSH — surfaces on the Payment Dashboard for the AP team.'}
                              style={{
                                display: 'inline-flex', alignItems: 'center', gap: 4,
                                padding: '2px 8px', borderRadius: 20,
                                fontSize: 10, fontWeight: 800, letterSpacing: '0.04em',
                                textTransform: 'uppercase', cursor: 'pointer',
                                border: `1px solid ${entry.rush_requested ? '#f97316' : (C.isDark ? '#3f3f46' : '#e5e7eb')}`,
                                background: entry.rush_requested
                                  ? (C.isDark ? '#3a1e08' : '#ffedd5')
                                  : 'transparent',
                                color: entry.rush_requested
                                  ? (C.isDark ? '#fdba74' : '#9a3412')
                                  : (C.isDark ? '#a1a1aa' : '#6b7280'),
                                fontFamily: 'inherit',
                              }}
                            >
                              <Zap size={10} style={{ fill: entry.rush_requested ? 'currentColor' : 'none' }} />
                              Rush
                            </button>
                          </div>
                          {entry.vendor_email && (
                            <div style={{ fontSize: 12, color: '#888' }}>{entry.vendor_email}</div>
                          )}
                          {(entry.artist || entry.song) && (
                            <div style={{ fontSize: 13, color: RED, fontWeight: 600, marginTop: 1, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                              <span>{entry.artist}{entry.song ? ` — ${entry.song}` : ''}</span>
                              {/* Off-roster chip — the vendor explicitly picked
                                  "Artist not on our roster" on submit. Distinct
                                  from the full unknown-artist banner below:
                                  this chip carries the vendor's declared intent
                                  and survives even if an admin later adds the
                                  artist to the roster. */}
                              {entry.off_roster_artist && (
                                <span
                                  title="Vendor submitted this as an off-roster artist"
                                  style={{
                                    display: 'inline-flex', alignItems: 'center',
                                    padding: '1px 6px', borderRadius: 4,
                                    fontSize: 10, fontWeight: 800, letterSpacing: '0.03em',
                                    background: C.isDark ? '#3a2f10' : '#fef3c7',
                                    color: C.isDark ? '#fbbf24' : '#92400e',
                                    border: `1px solid ${C.isDark ? '#a16207' : '#fcd34d'}`,
                                    textTransform: 'uppercase',
                                  }}
                                >
                                  Off-roster
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                        <button
                          onClick={async (e) => {
                            e.stopPropagation()
                            const val = !entry.cobrand
                            const prevCategory = entry.category
                            // Optimistic — flip immediately, revert if the PUT fails.
                            // Server forces category=Marketing on cobrand — mirror locally.
                            setEntries(prev => prev.map(en => en.id === entry.id
                              ? { ...en, cobrand: val, ...(val ? { category: 'Marketing' } : {}) }
                              : en))
                            try {
                              await api.put(`/bk/entries/${entry.id}`, { cobrand: val })
                            } catch {
                              setEntries(prev => prev.map(en => en.id === entry.id
                                ? { ...en, cobrand: !val, category: prevCategory }
                                : en))
                            }
                          }}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
                            padding: '5px 12px', borderRadius: 20, cursor: 'pointer',
                            fontSize: 11, fontWeight: 700, fontFamily: 'inherit', letterSpacing: '0.02em',
                            // Off state carries the cobrand blue as an outline
                            // + tint so the toggle reads as an actionable
                            // control, not disabled chrome.
                            border: entry.cobrand ? '1.5px solid transparent' : `1.5px solid ${C.isDark ? '#3b82f6' : '#93c5fd'}`,
                            background: entry.cobrand ? '#3b82f6' : (C.isDark ? 'rgba(59,130,246,0.10)' : '#eff6ff'),
                            color: entry.cobrand ? '#fff' : (C.isDark ? '#93c5fd' : '#2563eb'),
                            transition: 'all 0.2s',
                          }}
                          title={entry.cobrand ? 'Remove cobrand flag' : 'Mark as cobrand'}
                        >
                          <span style={{
                            width: 16, height: 16, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                            background: entry.cobrand ? 'rgba(255,255,255,0.25)' : (C.isDark ? 'rgba(59,130,246,0.25)' : '#dbeafe'),
                            fontSize: 10, fontWeight: 900, lineHeight: 1,
                            color: entry.cobrand ? '#fff' : (C.isDark ? '#93c5fd' : '#2563eb'),
                            transition: 'all 0.2s',
                          }}>
                            {entry.cobrand ? '✓' : '?'}
                          </span>
                          COBRAND
                        </button>
                        {/* Bulk-deal toggle — mirrors COBRAND. Flags the
                            invoice at review time so it lands on the Bulk
                            Deals page (deliverables tracker) and carries
                            the teal Bulk key in the Ledger. Qty/unit
                            editable inline once flagged. */}
                        <button
                          onClick={async (e) => {
                            e.stopPropagation()
                            const val = !entry.is_bulk_deal
                            try {
                              await api.put(`/bk/entries/${entry.id}`, { is_bulk_deal: val })
                              setEntries(prev => prev.map(en => en.id === entry.id ? { ...en, is_bulk_deal: val } : en))
                            } catch {}
                          }}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
                            padding: '5px 12px', borderRadius: 20, cursor: 'pointer',
                            fontSize: 11, fontWeight: 700, fontFamily: 'inherit', letterSpacing: '0.02em',
                            // Off state carries the bulk-deal teal as an
                            // outline + tint — same treatment as COBRAND.
                            border: entry.is_bulk_deal ? '1.5px solid transparent' : `1.5px solid ${C.isDark ? '#14b8a6' : '#5eead4'}`,
                            background: entry.is_bulk_deal ? '#0d9488' : (C.isDark ? 'rgba(20,184,166,0.10)' : '#f0fdfa'),
                            color: entry.is_bulk_deal ? '#fff' : (C.isDark ? '#5eead4' : '#0f766e'),
                            transition: 'all 0.2s',
                          }}
                          title={entry.is_bulk_deal ? 'Remove bulk-deal flag' : 'Mark as a bulk deal — tracked with deliverables on the Bulk Deals page'}
                        >
                          <span style={{
                            width: 16, height: 16, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                            background: entry.is_bulk_deal ? 'rgba(255,255,255,0.25)' : (C.isDark ? 'rgba(20,184,166,0.25)' : '#ccfbf1'),
                            fontSize: 10, fontWeight: 900, lineHeight: 1,
                            color: entry.is_bulk_deal ? '#fff' : (C.isDark ? '#5eead4' : '#0f766e'),
                            transition: 'all 0.2s',
                          }}>
                            {entry.is_bulk_deal ? '✓' : '?'}
                          </span>
                          BULK DEAL
                        </button>
                        {entry.is_bulk_deal && (
                          <div
                            style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}
                            onClick={e => e.stopPropagation()}
                            title="Deliverables on this deal — quantity + unit (e.g. 12 videos). Saves when you click away."
                          >
                            <input
                              type="number"
                              min="1"
                              defaultValue={entry.bulk_deal_quantity || ''}
                              placeholder="Qty"
                              onBlur={async (e) => {
                                const q = e.target.value ? Number(e.target.value) : null
                                if (q === (entry.bulk_deal_quantity ?? null)) return
                                try {
                                  await api.put(`/bk/entries/${entry.id}`, { bulk_deal_quantity: q })
                                  setEntries(prev => prev.map(en => en.id === entry.id ? { ...en, bulk_deal_quantity: q } : en))
                                } catch {}
                              }}
                              style={{
                                width: 56, padding: '4px 6px', borderRadius: 6, fontSize: 11,
                                border: `1px solid ${C.inputBorder}`, background: C.inputBg, color: C.text,
                              }}
                            />
                            <input
                              type="text"
                              defaultValue={entry.bulk_deal_unit || ''}
                              placeholder="unit (videos)"
                              onBlur={async (e) => {
                                const u = e.target.value.trim() || null
                                if (u === (entry.bulk_deal_unit || null)) return
                                try {
                                  await api.put(`/bk/entries/${entry.id}`, { bulk_deal_unit: u })
                                  setEntries(prev => prev.map(en => en.id === entry.id ? { ...en, bulk_deal_unit: u } : en))
                                } catch {}
                              }}
                              style={{
                                width: 92, padding: '4px 6px', borderRadius: 6, fontSize: 11,
                                border: `1px solid ${C.inputBorder}`, background: C.inputBg, color: C.text,
                              }}
                            />
                          </div>
                        )}
                        <div style={{ textAlign: 'right', flexShrink: 0 }}>
                          <div style={{ fontWeight: 900, fontSize: 18, color: RED, fontStyle: 'italic' }}
                            title={usdSuffixForEntry(entry, fxRates, { precise: true }).trim().replace(/^\(|\)$/g, '') || undefined}>
                            {formatMoney(entry.amount, entry.currency)}
                          </div>
                          {(entry.currency || 'USD').toUpperCase() !== 'USD' && (
                            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1, fontWeight: 500 }}>
                              {usdSuffixForEntry(entry, fxRates).trim().replace(/^\(|\)$/g, '')}
                            </div>
                          )}
                          <div style={{ fontSize: 12, color: '#aaa', marginTop: 2 }}>
                            {fmtDate(entry.invoice_date)}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* ── Name mismatch warning ── */}
                  {nameMismatch && (
                    <div style={{
                      margin: '12px 20px 0', padding: '8px 12px',
                      background: C.isDark ? '#302a1a' : '#fefce8', borderLeft: '3px solid #ca8a04',
                      fontSize: 13, color: C.isDark ? '#fbbf24' : '#92400e', display: 'flex', alignItems: 'center', gap: 8,
                    }}>
                      <AlertTriangle style={{ width: 14, height: 14, flexShrink: 0 }} />
                      <span>
                        Submitted as <strong>{entry.payee}</strong> — invoice reads <strong>{entry.vendor_name}</strong>
                      </span>
                    </div>
                  )}

                  {/* ── Unknown artist (not on roster) ── */}
                  {entry.unknown_artist && (
                    <div style={{
                      margin: '8px 20px 0', padding: '8px 12px',
                      background: C.isDark ? '#302a1a' : '#fefce8', borderLeft: '3px solid #ca8a04',
                      fontSize: 13, color: C.isDark ? '#fbbf24' : '#92400e', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                    }}>
                      <AlertTriangle style={{ width: 14, height: 14, flexShrink: 0 }} />
                      <span style={{ flex: 1, minWidth: 200 }}>
                        Artist <strong>"{entry.artist}"</strong> isn't on the roster.
                        {entry.suggested_artist_name && (
                          <> Did you mean <strong>"{entry.suggested_artist_name}"</strong>?</>
                        )}
                      </span>
                      {entry.suggested_artist_name && isAdmin && (
                        <button
                          onClick={() => applyArtistSuggestion(entry.id, entry.suggested_artist_name)}
                          style={{
                            background: 'none', border: '1px solid currentColor', borderRadius: 4,
                            padding: '3px 10px', fontSize: 11, fontWeight: 700, color: 'inherit',
                            cursor: 'pointer', fontFamily: 'inherit', opacity: 0.8, flexShrink: 0,
                          }}
                          onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                          onMouseLeave={e => e.currentTarget.style.opacity = '0.8'}
                          title={`Replace "${entry.artist}" with "${entry.suggested_artist_name}"`}
                        >
                          Use "{entry.suggested_artist_name}"
                        </button>
                      )}
                    </div>
                  )}

                  {/* ── Unknown song (not in the catalog / release pipeline) ── */}
                  {entry.unknown_song && (
                    <div style={{
                      margin: '8px 20px 0', padding: '8px 12px',
                      background: C.isDark ? '#302a1a' : '#fefce8', borderLeft: '3px solid #ca8a04',
                      fontSize: 13, color: C.isDark ? '#fbbf24' : '#92400e', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                    }}>
                      <AlertTriangle style={{ width: 14, height: 14, flexShrink: 0 }} />
                      <span style={{ flex: 1, minWidth: 200 }}>
                        Song <strong>"{entry.song}"</strong> isn't in the catalog.
                        {entry.suggested_song_name && (
                          <> Did you mean <strong>"{entry.suggested_song_name}"</strong>
                          {entry.suggested_release_artist && <> by {entry.suggested_release_artist}</>}?</>
                        )}
                      </span>
                      {entry.suggested_song_name && isAdmin && (
                        <button
                          onClick={() => applySongSuggestion(entry.id, entry.suggested_song_name, entry.suggested_release_id)}
                          style={{
                            background: 'none', border: '1px solid currentColor', borderRadius: 4,
                            padding: '3px 10px', fontSize: 11, fontWeight: 700, color: 'inherit',
                            cursor: 'pointer', fontFamily: 'inherit', opacity: 0.8, flexShrink: 0,
                          }}
                          onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                          onMouseLeave={e => e.currentTarget.style.opacity = '0.8'}
                          title={`Replace "${entry.song}" with "${entry.suggested_song_name}" and link to the catalog release`}
                        >
                          Use "{entry.suggested_song_name}"
                        </button>
                      )}
                    </div>
                  )}

                  {/* ── AI scan discrepancies ── */}
                  {/* Possible duplicate — AMBER and separate from the red AI
                      scan banner below, because this is not an AI finding and
                      shouldn't borrow its authority. The vendor form used to
                      refuse these outright, so the invoice never reached this
                      page at all; now it arrives and the call is yours. */}
                  {/* ── Payment details vs the document ──────────────────
                      The vendor form now COLLECTS bank details rather than
                      demanding they be printed on the invoice — an invoice that
                      omitted them used to be refused outright, which is the
                      wrong answer to "the vendor forgot something". The scan
                      still runs, and what it found is reported here.

                      Only the two states worth a human are shown. `match` and
                      `unscanned` are silent: one is the expected case and the
                      other means the AI was unavailable, and a banner for
                      either would be noise on every row. */}
                  {(entry.payment_check?.verdict === 'mismatch'
                    || entry.payment_check?.changed_from) && (
                    <div style={{
                      margin: '12px 20px 0', padding: '10px 14px',
                      background: C.isDark ? '#2a2412' : '#fffbeb',
                      borderLeft: '3px solid #d97706', borderRadius: '0 6px 6px 0',
                      fontSize: 12, color: C.isDark ? '#fcd34d' : '#92400e',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontWeight: 700 }}>
                        <AlertTriangle style={{ width: 13, height: 13 }} />
                        {entry.payment_check.verdict === 'mismatch'
                          ? 'The bank details on the form do not match the invoice'
                          : 'This vendor changed their payment details'}
                      </div>
                      {entry.payment_check.verdict === 'mismatch' && (
                        <div>
                          Form says <strong>••••{entry.payment_check.typed_last4}</strong>,
                          the invoice says <strong>••••{entry.payment_check.doc_last4}</strong>
                          {' '}({entry.payment_check.method}). Confirm with the vendor by a channel you
                          already trust before paying — redirected-payment fraud looks exactly like this.
                        </div>
                      )}
                      {entry.payment_check.changed_from && (() => {
                        // `changed_from` used to be {method, last4} — enough to
                        // say something changed, not enough to say what. It now
                        // carries the full previous snapshot, so the two can be
                        // diffed field by field. That difference IS the fraud
                        // signal: a redirected payment looks like exactly this.
                        const was = entry.payment_check.changed_from
                        const now = entry.payment_snapshot || {}
                        const FIELDS = [
                          ['Method', 'method'], ['Account', 'last4'],
                          ['Name on account', 'holder_name'], ['Bank', 'bank_name'],
                          ['Account type', 'account_type'], ['Wire type', 'wire_scope'],
                          ['Bank address', 'bank_address'],
                          ['Beneficiary address', 'beneficiary_address'],
                          ['PayPal', 'paypal'],
                        ]
                        const mask = (k, v) => (k === 'last4' && v ? '••••' + v : v)
                        const changed = FIELDS
                          .map(([label, k]) => [label, was[k], now[k], k])
                          .filter(([, a, b]) => (a || b) && a !== b)
                        return (
                          <div style={{ marginTop: 4 }}>
                            We previously held{' '}
                            <strong>{was.method} ••••{was.last4}</strong>
                            {' '}and this invoice gives{' '}
                            <strong>{entry.payment_check.method} ••••{entry.payment_check.typed_last4}</strong>.
                            {changed.length > 0 && (
                              <div style={{ marginTop: 6, display: 'grid', gridTemplateColumns: 'auto 1fr 1fr', gap: '2px 10px', fontSize: 11 }}>
                                <span style={{ opacity: 0.7, fontWeight: 700 }} />
                                <span style={{ opacity: 0.7, fontWeight: 700 }}>was</span>
                                <span style={{ opacity: 0.7, fontWeight: 700 }}>now</span>
                                {changed.map(([label, a, b, k]) => (
                                  <Fragment key={label}>
                                    <span style={{ opacity: 0.7 }}>{label}</span>
                                    <span style={{ textDecoration: 'line-through', opacity: 0.75 }}>{mask(k, a) || '—'}</span>
                                    <span style={{ fontWeight: 700 }}>{mask(k, b) || '—'}</span>
                                  </Fragment>
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      })()}
                    </div>
                  )}

                  {/* RED, not amber. John, 2026-09-15: "the invoice number already
                      on file is a big flag."

                      This page's amber says "look at this before you approve" —
                      an off-roster artist, a W9 we don't hold. Red says "this
                      could take money out of the building twice", and a repeated
                      invoice number is the one flag here that carries that
                      consequence: the vendor is asking to be paid again under a
                      number this ledger has already approved, and the matched
                      row's own status (shown on the line below) is what says
                      whether it was also already paid.

                      Same tokens as the AI-discrepancy banner below, which is
                      the page's existing red. Copied rather than picked, so the
                      two alerts cannot drift into two shades of "serious". */}
                  {entry.possible_duplicates?.length > 0 && (
                    <div style={{
                      margin: '12px 20px 0', padding: '10px 14px',
                      background: C.isDark ? '#2a1a1a' : '#fef2f2',
                      borderLeft: '3px solid #dc2626', borderRadius: '0 6px 6px 0',
                      fontSize: 12, color: C.isDark ? '#fca5a5' : '#991b1b',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontWeight: 700 }}>
                        <AlertTriangle style={{ width: 13, height: 13 }} />
                        Invoice number already on file for this vendor
                      </div>
                      {entry.possible_duplicates.map((d) => (
                        <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
                          <span style={{ fontWeight: 600 }}>#{d.invoice_number}</span>
                          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                            ${Number(d.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                          </span>
                          <span style={{ opacity: 0.8 }}>{String(d.invoice_date || '').slice(0, 10)}</span>
                          <span style={{ opacity: 0.8 }}>· {d.status}</span>
                          <a href={`/bk/ledger?focus=${d.id}`} target="_blank" rel="noreferrer"
                            style={{ marginLeft: 'auto', fontWeight: 700, textDecoration: 'underline' }}>
                            open entry #{d.id}
                          </a>
                        </div>
                      ))}
                      <div style={{ marginTop: 6, opacity: 0.85 }}>
                        Numbers are compared with leading zeros stripped, so 001 and 1 look the same —
                        check the amount and date before treating this as a repeat.
                      </div>
                    </div>
                  )}
                  {(() => {
                    const hasInvoiceOnFile = !!entry.has_invoice
                    const allDiscrepancies = entry.ai_scan?.discrepancies || []
                    // Filter only the synthetic "no document was attached" discrepancies
                    // (the original false-positive complaint). Real findings — including
                    // "this isn't an invoice" / "wrong document type" / "blank scan"
                    // — pass through unchanged so admins still see them.
                    const realDiscrepancies = allDiscrepancies.filter(d => !(hasInvoiceOnFile && isMissingDocClaim(d)))
                    const summary = entry.ai_scan?.summary
                    const ranAtInvoice = relativeAgo(entry.ai_scan?.scanned_at)
                    if (realDiscrepancies.length > 0) {
                      return (
                        <div style={{
                          margin: '12px 20px 0', padding: '10px 14px',
                          background: C.isDark ? '#2a1a1a' : '#fef2f2', borderLeft: '3px solid #dc2626', borderRadius: '0 6px 6px 0',
                          fontSize: 12, color: C.isDark ? '#fca5a5' : '#991b1b',
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontWeight: 700, fontSize: 12 }}>
                            <AlertTriangle style={{ width: 13, height: 13 }} />
                            AI Invoice Scan — {realDiscrepancies.length} discrepanc{realDiscrepancies.length === 1 ? 'y' : 'ies'} found
                            {ranAtInvoice && <span style={{ fontSize: 10, fontWeight: 500, opacity: 0.7, marginLeft: 6 }}>· {ranAtInvoice}</span>}
                            {isAdmin && (
                              <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                                <button
                                  onClick={() => rescanEntry(entry.id, 'invoice')}
                                  disabled={rescanningId === `${entry.id}:invoice`}
                                  style={{ background: 'none', border: '1px solid currentColor', borderRadius: 4, padding: '2px 8px', fontSize: 10, fontWeight: 700, color: 'inherit', cursor: 'pointer', fontFamily: 'inherit', opacity: rescanningId === `${entry.id}:invoice` ? 0.5 : 0.7 }}
                                  onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                                  onMouseLeave={e => e.currentTarget.style.opacity = '0.7'}
                                  title="Re-run the AI scan on this invoice"
                                >
                                  {rescanningId === `${entry.id}:invoice` ? 'Re-scanning…' : 'Re-scan'}
                                </button>
                                <button
                                  onClick={() => dismissScan(entry.id, 'invoice')}
                                  style={{ background: 'none', border: '1px solid currentColor', borderRadius: 4, padding: '2px 8px', fontSize: 10, fontWeight: 700, color: 'inherit', cursor: 'pointer', fontFamily: 'inherit', opacity: 0.7 }}
                                  onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                                  onMouseLeave={e => e.currentTarget.style.opacity = '0.7'}
                                  title="Dismiss these warnings"
                                >
                                  Dismiss
                                </button>
                              </span>
                            )}
                          </div>
                          {realDiscrepancies.map((d, i) => (
                            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '3px 0', fontSize: 12 }}>
                              <span style={{
                                fontSize: 9, fontWeight: 800, textTransform: 'uppercase', padding: '1px 5px', borderRadius: 3,
                                background: d.severity === 'high' ? '#dc2626' : d.severity === 'medium' ? '#ea580c' : '#ca8a04',
                                color: '#fff', flexShrink: 0,
                              }}>{d.severity}</span>
                              <span style={{ flex: 1 }}><strong>{d.field}:</strong> form says <em>"{d.form_value}"</em> — document shows <em>"{d.document_value}"</em></span>
                              {isAdmin && (
                                <button
                                  onClick={() => dismissDiscrepancy(entry.id, 'invoice', d)}
                                  title="Dismiss this discrepancy"
                                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', fontSize: 13, color: 'inherit', opacity: 0.4, lineHeight: 1, flexShrink: 0 }}
                                  onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                                  onMouseLeave={e => e.currentTarget.style.opacity = '0.4'}
                                >×</button>
                              )}
                            </div>
                          ))}
                          {summary && (
                            <div style={{ marginTop: 6, fontSize: 11, color: '#777', fontStyle: 'italic' }}>{summary}</div>
                          )}
                        </div>
                      )
                    }
                    if (entry.ai_scan) {
                      const ranAt = relativeAgo(entry.ai_scan?.scanned_at)
                      return (
                        <div style={{
                          margin: '12px 20px 0', padding: '8px 12px',
                          background: C.isDark ? '#1a2a1a' : '#f0fdf4', borderLeft: '3px solid #16a34a', borderRadius: '0 6px 6px 0',
                          fontSize: 12, color: C.isDark ? '#86efac' : '#065f46', display: 'flex', alignItems: 'center', gap: 6,
                        }}>
                          <CheckCircle2 style={{ width: 13, height: 13, flexShrink: 0 }} />
                          <span style={{ flex: 1 }}>{summary || 'AI invoice scan: no issues found.'}</span>
                          {ranAt && <span style={{ fontSize: 10, opacity: 0.7, flexShrink: 0 }}>{ranAt}</span>}
                          {isAdmin && (
                            <button
                              onClick={() => rescanEntry(entry.id, 'invoice')}
                              disabled={rescanningId === `${entry.id}:invoice`}
                              style={{ background: 'none', border: '1px solid currentColor', borderRadius: 4, padding: '2px 8px', fontSize: 10, fontWeight: 700, color: 'inherit', cursor: 'pointer', fontFamily: 'inherit', opacity: rescanningId === `${entry.id}:invoice` ? 0.5 : 0.6, flexShrink: 0 }}
                              onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                              onMouseLeave={e => e.currentTarget.style.opacity = '0.6'}
                              title="Re-run the AI scan on this invoice"
                            >
                              {rescanningId === `${entry.id}:invoice` ? 'Re-scanning…' : 'Re-scan'}
                            </button>
                          )}
                        </div>
                      )
                    }
                    return null
                  })()}

                  {/* ── W9/W8 scan discrepancies ── */}
                  {(() => {
                    const hasW9OnFile = !!entry.has_w9 || !!entry.w9_entry_id
                    const allDiscrepancies = entry.w9_scan?.discrepancies || []
                    // Filter only the synthetic "no W-9 was attached" discrepancies
                    // (the original false-positive complaint). Real findings — like
                    // "this is a bank statement, not a W-9" — pass through.
                    const realDiscrepancies = allDiscrepancies.filter(d => !(hasW9OnFile && isMissingDocClaim(d)))
                    const summary = entry.w9_scan?.summary
                    const formLabel = entry.w9_scan?.form_type && entry.w9_scan.form_type !== 'unknown' ? entry.w9_scan.form_type : 'W9'
                    const ranAtW9 = relativeAgo(entry.w9_scan?.scanned_at)
                    if (realDiscrepancies.length > 0) {
                      return (
                        <div style={{
                          margin: '8px 20px 0', padding: '10px 14px',
                          background: C.isDark ? '#2a2218' : '#fff7ed', borderLeft: '3px solid #ea580c', borderRadius: '0 6px 6px 0',
                          fontSize: 12, color: C.isDark ? '#fdba74' : '#9a3412',
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontWeight: 700, fontSize: 12 }}>
                            <AlertTriangle style={{ width: 13, height: 13 }} />
                            AI {formLabel} Scan — {realDiscrepancies.length} discrepanc{realDiscrepancies.length === 1 ? 'y' : 'ies'} found
                            {ranAtW9 && <span style={{ fontSize: 10, fontWeight: 500, opacity: 0.7, marginLeft: 6 }}>· {ranAtW9}</span>}
                            {isAdmin && (
                              <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                                <button
                                  onClick={() => rescanEntry(entry.id, 'w9')}
                                  disabled={rescanningId === `${entry.id}:w9`}
                                  style={{ background: 'none', border: '1px solid currentColor', borderRadius: 4, padding: '2px 8px', fontSize: 10, fontWeight: 700, color: 'inherit', cursor: 'pointer', fontFamily: 'inherit', opacity: rescanningId === `${entry.id}:w9` ? 0.5 : 0.7 }}
                                  onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                                  onMouseLeave={e => e.currentTarget.style.opacity = '0.7'}
                                  title="Re-run the AI scan on this W9/W8 form"
                                >
                                  {rescanningId === `${entry.id}:w9` ? 'Re-scanning…' : 'Re-scan'}
                                </button>
                                <button
                                  onClick={() => dismissScan(entry.id, 'w9')}
                                  style={{ background: 'none', border: '1px solid currentColor', borderRadius: 4, padding: '2px 8px', fontSize: 10, fontWeight: 700, color: 'inherit', cursor: 'pointer', fontFamily: 'inherit', opacity: 0.7 }}
                                  onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                                  onMouseLeave={e => e.currentTarget.style.opacity = '0.7'}
                                  title="Dismiss these warnings"
                                >
                                  Dismiss
                                </button>
                              </span>
                            )}
                          </div>
                          {realDiscrepancies.map((d, i) => (
                            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '3px 0', fontSize: 12 }}>
                              <span style={{
                                fontSize: 9, fontWeight: 800, textTransform: 'uppercase', padding: '1px 5px', borderRadius: 3,
                                background: d.severity === 'high' ? '#dc2626' : d.severity === 'medium' ? '#ea580c' : '#ca8a04',
                                color: '#fff', flexShrink: 0,
                              }}>{d.severity}</span>
                              <span style={{ flex: 1 }}><strong>{d.field}:</strong> submitted <em>"{d.form_value}"</em> — {formLabel} shows <em>"{d.w9_value}"</em></span>
                              {isAdmin && (
                                <button
                                  onClick={() => dismissDiscrepancy(entry.id, 'w9', d)}
                                  title="Dismiss this discrepancy"
                                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', fontSize: 13, color: 'inherit', opacity: 0.4, lineHeight: 1, flexShrink: 0 }}
                                  onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                                  onMouseLeave={e => e.currentTarget.style.opacity = '0.4'}
                                >×</button>
                              )}
                            </div>
                          ))}
                          {summary && (
                            <div style={{ marginTop: 6, fontSize: 11, color: '#777', fontStyle: 'italic' }}>{summary}</div>
                          )}
                        </div>
                      )
                    }
                    if (entry.w9_scan) {
                      const ranAt = relativeAgo(entry.w9_scan?.scanned_at)
                      return (
                        <div style={{
                          margin: '8px 20px 0', padding: '8px 12px',
                          background: C.isDark ? '#1a2a1a' : '#f0fdf4', borderLeft: '3px solid #16a34a', borderRadius: '0 6px 6px 0',
                          fontSize: 12, color: C.isDark ? '#86efac' : '#065f46', display: 'flex', alignItems: 'center', gap: 6,
                        }}>
                          <CheckCircle2 style={{ width: 13, height: 13, flexShrink: 0 }} />
                          <span style={{ flex: 1 }}>{summary ? `${formLabel}: ${summary}` : `AI ${formLabel} scan: no issues found.`}</span>
                          {ranAt && <span style={{ fontSize: 10, opacity: 0.7, flexShrink: 0 }}>{ranAt}</span>}
                          {isAdmin && (
                            <button
                              onClick={() => rescanEntry(entry.id, 'w9')}
                              disabled={rescanningId === `${entry.id}:w9`}
                              style={{ background: 'none', border: '1px solid currentColor', borderRadius: 4, padding: '2px 8px', fontSize: 10, fontWeight: 700, color: 'inherit', cursor: 'pointer', fontFamily: 'inherit', opacity: rescanningId === `${entry.id}:w9` ? 0.5 : 0.6, flexShrink: 0 }}
                              onMouseEnter={e => e.currentTarget.style.opacity = '1'}
                              onMouseLeave={e => e.currentTarget.style.opacity = '0.6'}
                              title="Re-run the AI scan on this W9/W8 form"
                            >
                              {rescanningId === `${entry.id}:w9` ? 'Re-scanning…' : 'Re-scan'}
                            </button>
                          )}
                        </div>
                      )
                    }
                    return null
                  })()}

                  {/* ── Metadata row ── */}
                  <div style={{
                    padding: '12px 20px 0', display: 'flex', gap: 6, flexWrap: 'wrap',
                    alignItems: 'center', fontSize: 13, color: C.isDark ? '#aaa' : '#555',
                  }}>
                    <span style={{ color: '#9ca3af', fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em' }}>DATE</span>
                    <span style={{ fontWeight: 600 }}>{fmtDate(entry.invoice_date)}</span>
                    {entry.invoice_number && (
                      <>
                        <span style={{ color: '#d1d5db', margin: '0 4px' }}>·</span>
                        <span style={{ color: '#9ca3af', fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em' }}>#</span>
                        <span style={{ fontWeight: 600 }}>{entry.invoice_number}</span>
                      </>
                    )}
                    {editingId !== entry.id && (
                      <>
                        <span style={{ color: '#d1d5db', margin: '0 4px' }}>·</span>
                        <span style={{ color: '#9ca3af', fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em' }}>CAT</span>
                        <select
                          value={entry.category || ''}
                          onChange={e => saveCategory(entry.id, e.target.value)}
                          title="Change category"
                          style={{
                            background: 'none', border: 'none',
                            fontSize: 13, fontWeight: 600, color: entry.category ? C.text : '#9ca3af',
                            fontFamily: 'inherit', cursor: 'pointer', padding: '0 2px',
                            outline: 'none', appearance: 'none', WebkitAppearance: 'none',
                          }}
                        >
                          <option value="">— set —</option>
                          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </>
                    )}
                    {entry.boom_rep && (
                      <>
                        <span style={{ color: '#d1d5db', margin: '0 4px' }}>·</span>
                        <span style={{ color: '#9ca3af', fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em' }}>REP</span>
                        <span style={{ fontWeight: 600 }}>{entry.boom_rep}</span>
                      </>
                    )}
                  </div>

                  {/* ── Description ── */}
                  {desc && (
                    <div style={{ padding: '8px 20px 0', fontSize: 13, color: C.isDark ? '#aaa' : '#666', lineHeight: 1.5 }}>
                      <span style={{ color: '#9ca3af', fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', marginRight: 8 }}>DESC</span>
                      {isLong && !showFull ? desc.slice(0, 120) + '...' : desc}
                      {isLong && (
                        <span
                          onClick={() => setExpandedDesc(p => ({ ...p, [entry.id]: !p[entry.id] }))}
                          style={{ color: '#999', cursor: 'pointer', marginLeft: 6, fontSize: 12, fontWeight: 600 }}
                        >
                          {showFull ? 'less' : 'more'}
                        </span>
                      )}
                    </div>
                  )}

                  {/* ── File chips ── */}
                  {(entry.invoice_filename || entry.w9_filename || entry.has_invoice || entry.has_w9 || entry.w9_entry_id) && (
                    <div style={{ padding: '10px 20px 0', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <FileChip filename={entry.invoice_filename} hasFile={!!entry.has_invoice} type="invoice" entryId={entry.id} onPreview={(url, name) => setPreviewFile({ url, filename: name })} theme={theme} />
                      <FileChip filename={entry.w9_filename} hasFile={!!(entry.has_w9 || entry.w9_entry_id)} type="w9" entryId={entry.w9_entry_id || entry.id} onPreview={(url, name) => setPreviewFile({ url, filename: name })} theme={theme} />
                      {(Array.isArray(entry.attachments) ? entry.attachments : []).map(a => (
                        <AttachmentChip key={a.id} attachment={a} entryId={entry.id}
                          onPreview={(url, name) => setPreviewFile({ url, filename: name })} theme={theme} />
                      ))}
                    </div>
                  )}

                  {/* ── Artist breakdown (collapsible) ── */}
                  {showArtistBreakdown[entry.id] && (
                    <div style={{ margin: '12px 20px 0', background: C.elevBg, border: '1.5px solid ' + C.border, borderRadius: 8, padding: '12px 14px' }}>
                      <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#9ca3af', marginBottom: 8 }}>Artist Breakdown</div>
                      {(artistBreakdown[entry.id] || []).map((row, idx) => (
                        <div key={idx} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                          <input type="text" placeholder="Artist" value={row.artist}
                            onChange={e => updateArtistRow(entry.id, idx, 'artist', e.target.value)}
                            style={{ ...inputSty, paddingLeft: 10, flex: 1, width: 'auto' }} />
                          <input type="text" placeholder="Song" value={row.song}
                            onChange={e => updateArtistRow(entry.id, idx, 'song', e.target.value)}
                            style={{ ...inputSty, paddingLeft: 10, flex: 1, width: 'auto' }} />
                          <input type="number" step="0.01" placeholder="Amount" value={row.amount}
                            onChange={e => updateArtistRow(entry.id, idx, 'amount', e.target.value)}
                            style={{ ...inputSty, paddingLeft: 10, width: 100 }} />
                          <button onClick={() => removeArtistRow(entry.id, idx)}
                            style={{ background: 'none', border: 'none', color: RED, cursor: 'pointer', padding: 4 }}>
                            <Trash2 style={{ width: 14, height: 14 }} />
                          </button>
                        </div>
                      ))}
                      <button onClick={() => addArtistRow(entry.id)}
                        style={{ background: 'none', border: 'none', color: RED, cursor: 'pointer', fontSize: 12, fontWeight: 700, fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 4, padding: '4px 0' }}>
                        <Plus style={{ width: 14, height: 14 }} /> Add row
                      </button>
                    </div>
                  )}

                  {/* ── Reject reason form ── */}
                  {rejectingId === entry.id && (
                    <div style={{ margin: '0 20px', padding: '12px 14px', background: C.isDark ? '#2a1a1a' : '#fef2f2', borderRadius: 8, border: '1px solid ' + (C.isDark ? '#5c2020' : '#fca5a5') }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: '#991b1b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                        Reason for rejection <span style={{ color: RED }}>*</span>
                      </div>
                      <textarea
                        autoFocus
                        value={rejectReason[entry.id] || ''}
                        onChange={e => setRejectReason(prev => ({ ...prev, [entry.id]: e.target.value }))}
                        placeholder="Explain why this invoice is being rejected..."
                        style={{
                          width: '100%', minHeight: 60, resize: 'vertical',
                          background: C.inputBg, border: '1.5px solid #fca5a5', borderRadius: 6,
                          padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', outline: 'none',
                          color: C.text,
                        }}
                      />
                      <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', justifyContent: 'flex-end' }}>
                        {entry.vendor_submitted && entry.vendor_email && (
                          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: '#991b1b', cursor: 'pointer', marginRight: 'auto' }}>
                            <input
                              type="checkbox"
                              checked={notifyVendor[entry.id] ?? false}
                              onChange={e => setNotifyVendor(prev => ({ ...prev, [entry.id]: e.target.checked }))}
                              style={{ accentColor: RED, cursor: 'pointer' }}
                            />
                            Email {entry.vendor_email} about this rejection
                          </label>
                        )}
                        <button
                          onClick={() => { setRejectingId(null); setRejectReason(prev => ({ ...prev, [entry.id]: '' })) }}
                          style={{ background: C.cardBg, border: '1.5px solid ' + C.border, borderRadius: 6, padding: '6px 14px', fontSize: 12, fontWeight: 600, color: C.textMuted, fontFamily: 'inherit', cursor: 'pointer' }}
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => handleReject(entry.id)}
                          disabled={processingId === entry.id || !(rejectReason[entry.id] || '').trim()}
                          style={{
                            background: RED, border: 'none', borderRadius: 6,
                            padding: '6px 14px', fontSize: 12, fontWeight: 700, color: '#fff',
                            fontFamily: 'inherit', cursor: 'pointer',
                            opacity: (processingId === entry.id || !(rejectReason[entry.id] || '').trim()) ? 0.4 : 1,
                          }}
                        >
                          {processingId === entry.id ? 'Rejecting...' : 'Confirm Rejection'}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* ── Alias panel ── */}
                  {aliasPanelId === entry.payee && (
                    <div style={{ margin: '12px 20px 0', background: C.elevBg, border: '1.5px solid ' + C.border, borderRadius: 8, padding: '12px 14px' }}>
                      <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#9ca3af', marginBottom: 8 }}>
                        Aliases for "{entry.payee}"
                      </div>
                      {(aliasesByPayee[entry.payee] || []).length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                          {aliasesByPayee[entry.payee].map(a => (
                            <span key={a.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: C.cardBg, border: '1px solid ' + C.border, borderRadius: 6, padding: '3px 8px', fontSize: 12, color: C.text }}>
                              {a.alias}
                              <button onClick={() => removeAliasById(a.id, entry.payee)}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#999', fontSize: 14, padding: 0, lineHeight: 1 }}
                                onMouseEnter={e => e.currentTarget.style.color = '#dc2626'}
                                onMouseLeave={e => e.currentTarget.style.color = '#999'}
                                title="Remove alias">×</button>
                            </span>
                          ))}
                        </div>
                      )}
                      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, fontWeight: 600 }}>Add alternate name (DBA, business name…)</div>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10 }}>
                        <input type="text" value={newAliasText} onChange={e => setNewAliasText(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') addAliasForPayee(entry.payee) }}
                          placeholder="e.g. Eddie M."
                          style={{ flex: 1, background: C.inputBg, border: '1.5px solid ' + C.inputBorder, borderRadius: 6, padding: '6px 10px', fontSize: 12, color: C.text, fontFamily: 'inherit', outline: 'none' }} />
                        <button onClick={() => addAliasForPayee(entry.payee)} disabled={!newAliasText.trim() || aliasSaving}
                          style={{ background: RED, color: '#fff', border: 'none', borderRadius: 6, padding: '6px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', opacity: (!newAliasText.trim() || aliasSaving) ? 0.4 : 1 }}>
                          Add
                        </button>
                      </div>
                      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, fontWeight: 600 }}>Or link "{entry.payee}" as an alias of an existing vendor</div>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <div style={{ flex: 1 }}>
                          <SearchableSelect
                            value={linkToVendor}
                            onChange={setLinkToVendor}
                            options={allVendors.filter(v => v.toLowerCase() !== (entry.payee || '').toLowerCase())}
                            placeholder="Type vendor name…"
                            style={{ width: '100%', border: '1.5px solid ' + C.inputBorder, borderRadius: 6, padding: '6px 10px', fontSize: 12, color: C.text, background: C.inputBg, fontFamily: 'inherit', outline: 'none' }}
                          />
                        </div>
                        <button onClick={() => linkPayeeToVendor(entry.payee, linkToVendor)} disabled={!linkToVendor || aliasSaving}
                          style={{ background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', opacity: (!linkToVendor || aliasSaving) ? 0.4 : 1, whiteSpace: 'nowrap' }}>
                          Link
                        </button>
                      </div>
                    </div>
                  )}

                  {/* ── Actions ── */}
                  <div style={{
                    padding: isMobileView ? '12px 14px 14px' : '14px 20px 16px', display: 'flex', alignItems: 'center',
                    justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap', rowGap: 10,
                  }}>
                    <div style={{ display: 'flex', gap: 6, marginRight: 'auto', flexWrap: 'wrap', ...(isMobileView ? { width: '100%' } : null) }}>
                      <button
                        onClick={() => setShowArtistBreakdown(p => ({ ...p, [entry.id]: !p[entry.id] }))}
                        style={{
                          background: 'none', border: '1.5px solid ' + C.border, borderRadius: 8,
                          padding: '8px 14px', fontSize: 12, fontWeight: 600, color: C.textMuted,
                          fontFamily: 'inherit', cursor: 'pointer',
                        }}
                      >
                        {showArtistBreakdown[entry.id] ? 'Hide split' : 'Split'}
                      </button>
                      {editingId === entry.id ? (
                        <>
                          <button
                            onClick={cancelEdit}
                            style={{
                              background: 'none', border: '1.5px solid ' + C.border, borderRadius: 8,
                              padding: '8px 14px', fontSize: 12, fontWeight: 600, color: C.textMuted,
                              fontFamily: 'inherit', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4,
                            }}
                          >
                            <X style={{ width: 13, height: 13 }} /> Cancel
                          </button>
                          <button
                            onClick={() => saveEdit(entry.id)}
                            disabled={savingEdit}
                            style={{
                              background: '#2563eb', border: 'none', borderRadius: 8,
                              padding: '8px 14px', fontSize: 12, fontWeight: 700, color: '#fff',
                              fontFamily: 'inherit', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4,
                              opacity: savingEdit ? 0.5 : 1,
                            }}
                          >
                            <Save style={{ width: 13, height: 13 }} /> {savingEdit ? 'Saving & rescanning…' : 'Save'}
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => startEdit(entry)}
                            style={{
                              background: 'none', border: '1.5px solid ' + C.border, borderRadius: 8,
                              padding: '8px 14px', fontSize: 12, fontWeight: 600, color: C.textMuted,
                              fontFamily: 'inherit', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4,
                            }}
                          >
                            <Pencil style={{ width: 12, height: 12 }} /> Edit
                          </button>
                          {isAdmin && (
                            <button
                              onClick={() => aliasPanelId === entry.payee ? closeAliasPanel() : openAliasPanel(entry.payee)}
                              style={{
                                background: aliasPanelId === entry.payee ? 'rgba(51, 65, 85,.08)' : 'none',
                                border: '1.5px solid ' + (aliasPanelId === entry.payee ? RED : C.border), borderRadius: 8,
                                padding: '8px 14px', fontSize: 12, fontWeight: 600,
                                color: aliasPanelId === entry.payee ? RED : C.textMuted,
                                fontFamily: 'inherit', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4,
                              }}
                            >
                              <Link2 style={{ width: 12, height: 12 }} /> Aliases
                            </button>
                          )}
                        </>
                      )}
                    </div>
                    {(() => {
                      const hasEmail = !!entry.vendor_email
                      const on = !!notifyVendor[entry.id]
                      return (
                        <button
                          type="button"
                          onClick={() => hasEmail && setNotifyVendor(prev => ({ ...prev, [entry.id]: !on }))}
                          disabled={!hasEmail}
                          title={hasEmail
                            ? (on ? `Vendor (${entry.vendor_email}) will be emailed on approve/reject` : 'Vendor will NOT be emailed on approve/reject')
                            : 'No vendor email on file — cannot notify'}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 6, marginRight: 8,
                            padding: '5px 12px', borderRadius: 20,
                            fontSize: 11, fontWeight: 700, fontFamily: 'inherit', letterSpacing: '0.02em',
                            border: 'none',
                            background: !hasEmail
                              ? (C.isDark ? '#2a2d38' : '#f0f0f0')
                              : on ? GREEN : (C.isDark ? '#2a2d38' : '#f0f0f0'),
                            color: !hasEmail
                              ? (C.isDark ? '#555' : '#bbb')
                              : on ? '#fff' : (C.isDark ? '#888' : '#777'),
                            cursor: hasEmail ? 'pointer' : 'not-allowed',
                            transition: 'all 0.2s',
                          }}
                        >
                          <span style={{
                            width: 16, height: 16, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                            background: !hasEmail
                              ? (C.isDark ? '#3a3d48' : '#ddd')
                              : on ? 'rgba(255,255,255,0.25)' : (C.isDark ? '#3a3d48' : '#ddd'),
                            fontSize: 10, fontWeight: 900, lineHeight: 1,
                            color: !hasEmail
                              ? (C.isDark ? '#555' : '#bbb')
                              : on ? '#fff' : (C.isDark ? '#666' : '#aaa'),
                            transition: 'all 0.2s',
                          }}>
                            {on && hasEmail ? '✓' : '✉'}
                          </span>
                          NOTIFY VENDOR
                        </button>
                      )
                    })()}
                    <button
                      onClick={() => openRejectForm(entry)}
                      disabled={processingId === entry.id}
                      style={{
                        background: rejectingId === entry.id ? RED : C.cardBg,
                        border: `1.5px solid ${RED}`, borderRadius: 8,
                        padding: isMobileView ? '12px 20px' : '8px 20px', fontSize: 13, fontWeight: 700,
                        color: rejectingId === entry.id ? '#fff' : RED,
                        fontFamily: 'inherit', cursor: 'pointer',
                        opacity: processingId === entry.id ? 0.5 : 1,
                        ...(isMobileView ? { flex: 1 } : null),
                      }}
                    >
                      Reject
                    </button>
                    <button
                      onClick={() => handleApprove(entry.id)}
                      disabled={processingId === entry.id}
                      style={{
                        background: GREEN, border: 'none', borderRadius: 8,
                        padding: isMobileView ? '12px 20px' : '8px 20px', fontSize: 13, fontWeight: 700, color: '#fff',
                        fontFamily: 'inherit', cursor: 'pointer',
                        opacity: processingId === entry.id ? 0.5 : 1,
                        ...(isMobileView ? { flex: 2 } : null),
                      }}
                    >
                      Review
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* File preview modal */}
      {previewFile && (
        <FilePreview
          url={previewFile.url}
          filename={previewFile.filename}
          onClose={() => setPreviewFile(null)}
        />
      )}

      {deckIds && (() => {
        // Resolve ids to live entries at RENDER time, not when the deck opened:
        // approving inside the deck removes rows from `entries`, and a snapshot
        // taken on open would keep handing the deck rows that no longer exist.
        const items = deckIds.map(id => entries.find(e => e.id === id)).filter(Boolean)
        if (!items.length) return null
        return (
          <ApprovalChecklistDeck
            items={items}
            categories={CATEGORIES}
            // NOT gated on showArtistBreakdown. That flag is a display
            // preference — whether the panel on the card is expanded — and it
            // was deciding whether the split TRAVELLED WITH THE APPROVAL. The
            // approve endpoint only splits when artist_breakdown is in the
            // request body, with no fallback to the stored column, so clicking
            // "Hide split" and then approving filed a two-artist invoice as ONE
            // row for the first artist, silently dropping the second's share.
            breakdownFor={(id) => artistBreakdown[id] || null}
            notifyFor={(id) => notifyVendor[id] ?? false}
            onApproved={handleDeckApproved}
            onEntryPatched={handleDeckPatched}
            onClose={() => setDeckIds(null)}
          />
        )
      })()}

      {w9Deck && w9Queue.length > 0 && (
        <W9ReviewDeck
          items={w9Queue}
          onReviewed={() => { /* the queue reloads on close */ }}
          onClose={() => { setW9Deck(false); loadW9Queue() }}
        />
      )}

      {emailQueue.length > 0 && (() => {
        const head = emailQueue[0]
        const queued = emailQueue.length - 1
        const subtitle = queued > 0
          ? `${queued} more queued${head.context?.entryId ? ` · Entry #${head.context.entryId}` : ''}`
          : (head.context?.entryId ? `Entry #${head.context.entryId}` : undefined)
        return (
          <EmailPreviewModal
            open
            title={head.kind === 'vendor_approved' ? 'Send approval email' : 'Send rejection email'}
            subtitle={subtitle}
            initialTo={head.to}
            initialCc={head.cc}
            initialSubject={head.subject}
            initialHtml={head.html}
            team={teamRoster}
            previewKind={head.kind}
            previewContext={head.context}
            attachmentLabels={head.attachmentLabels}
            onClose={advanceQueue}
            onSent={() => { setToast('Email sent'); setTimeout(() => setToast(''), 2400); advanceQueue() }}
            onSkipped={() => advanceQueue()}
            skipLabel="Skip"
          />
        )
      })()}
    </div>
  )
}
