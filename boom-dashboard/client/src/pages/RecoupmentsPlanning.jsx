// Recoupment upload planning — /recoupments/planning.
//
// The staging area between "picked from Pending" and "committed to
// this month's statement." Workflow:
//   1. Operator selects items on the Recoupments Pending tab and
//      hits "Add to plan" — items land here.
//   2. Here they GROUP items by recoupment_label (create labels
//      like "August Radio Push"), move items between labels,
//      remove items from the plan.
//   3. Click "Done" — every planned item is bulk-marked UFR now
//      (ufr='Yes' + ufr_marked_at=NOW()) with its assigned label
//      written to recoupment_label. They automatically populate
//      the CURRENT month's statement tab on the Recoupments page.
//
// Plan state lives entirely in localStorage until Done. See
// lib/recoupmentPlan for the shape.

import { useState, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft, Check, CheckCircle2, Copy, Loader, RotateCcw, X, Plus, Tag,
  MoveRight, ChevronDown, ChevronRight, Music2, FolderOpen, Bookmark, Upload,
  FileText, AtSign, Sparkles, Trash2, Flag, MessageSquare,
} from 'lucide-react'
import api from '../api'
import PageHeader from '../components/PageHeader'
import FilePreview from '../components/FilePreview'
import CommentThreadButton from '../components/CommentThreadButton'
import FlagButton from '../components/FlagButton'
import { formatDate, fmtMoney, totalsToUsd, usdSuffixForEntry, withoutUnreviewedBankRows } from '../utils'
import { useFxRates } from '../context/FxRatesContext'
import {
  loadPlan, savePlan, removeFromPlan, setLabelForItems,
  clearPlan, planSize,
} from '../lib/recoupmentPlan'

// Canonical "no label" bucket key so grouping code can key off a
// single sentinel instead of juggling empty strings.
const UNLABELED = ''

// Parse social_handles rows for the read-only chip — same normalization
// the Recoupments / Campaigns pages use.
function socialsList(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .map(s => {
      const platform = (s?.platform || '').trim()
      const handle = (s?.handle || '').trim()
      if (!handle) return null
      return { platform, handle, display: (platform ? `${platform} ${handle}` : handle) + (s?.amount ? ` · $${s.amount}` : '') }
    })
    .filter(Boolean)
}

function sumByCurrency(items) {
  const totals = {}
  for (const it of items) {
    const cur = (it.currency || 'USD').toUpperCase()
    totals[cur] = (totals[cur] || 0) + (Number(it.amount) || 0)
  }
  return totals
}
function fmtTotals(totals) {
  const parts = Object.entries(totals).filter(([, v]) => v > 0)
  if (!parts.length) return fmtMoney(0)
  parts.sort(([a], [b]) => a === 'USD' ? -1 : b === 'USD' ? 1 : a.localeCompare(b))
  return parts.map(([cur, v]) => fmtMoney(v, cur)).join(' + ')
}

export default function RecoupmentsPlanning() {
  const navigate = useNavigate()
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [plan, setPlan] = useState(loadPlan)
  // Page-level notes — shared scratchpad for the planning workflow,
  // persisted in recoupment_notes under a sentinel artist key (same
  // pattern as the Recoupments index notes).
  const PLAN_NOTE_KEY = '__recoupments_planning__'
  const [pageNote, setPageNote] = useState('')
  const [pageNoteSaving, setPageNoteSaving] = useState(false)
  const pageNoteSaved = useRef('')
  useEffect(() => {
    api.get('/bk/recoupments/notes', { params: { artist: PLAN_NOTE_KEY } })
      .then(r => {
        const n = r.data?.data?.artistNote || ''
        setPageNote(n)
        pageNoteSaved.current = n
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const savePageNote = async () => {
    if (pageNote === pageNoteSaved.current) return
    setPageNoteSaving(true)
    try {
      await api.put('/bk/recoupments/notes', { artist: PLAN_NOTE_KEY, note: pageNote })
      pageNoteSaved.current = pageNote
    } catch (err) {
      console.error('Failed to save planning notes:', err)
    } finally { setPageNoteSaving(false) }
  }

  // Artist-level flags — the shared artist_meta.flagged the Recoupments
  // and Campaigns pages read, so a flag raised on a planning card is
  // visible everywhere the artist appears.
  const [artistMeta, setArtistMeta] = useState({})
  useEffect(() => {
    api.get('/bk/artist-meta')
      .then(r => setArtistMeta(r.data?.data || {}))
      .catch(() => {})
  }, [])
  const metaForArtist = (name) => artistMeta[(name || '').toLowerCase().trim()] || {}
  const setArtistFlag = async (artistName, flagged, reason = null) => {
    const key = (artistName || '').toLowerCase().trim()
    setArtistMeta(prev => ({
      ...prev,
      [key]: { ...(prev[key] || {}), artist_key: key, flagged, flag_reason: flagged ? (reason ?? prev[key]?.flag_reason ?? null) : null },
    }))
    try {
      const body = { artist: artistName, flagged }
      if (reason != null) body.flag_reason = reason
      const { data } = await api.put('/bk/artist-meta', body)
      if (data?.data?.artist_key) setArtistMeta(prev => ({ ...prev, [data.data.artist_key]: data.data }))
    } catch (err) {
      alert('Failed to save flag: ' + (err?.response?.data?.error || err.message))
      api.get('/bk/artist-meta').then(r => setArtistMeta(r.data?.data || {})).catch(() => {})
    }
  }
  const saveArtistFlagReason = async (artistName, reason) => {
    const key = (artistName || '').toLowerCase().trim()
    setArtistMeta(prev => ({ ...prev, [key]: { ...(prev[key] || {}), artist_key: key, flag_reason: reason || null } }))
    try {
      await api.put('/bk/artist-meta', { artist: artistName, flag_reason: reason || '' })
    } catch (err) {
      alert('Failed to save reason: ' + (err?.response?.data?.error || err.message))
    }
  }
  // "Save for later" — artist keys set aside for a future batch. They
  // group at the bottom of the cards view and are EXCLUDED from the
  // Done commit and the headline totals. Same per-browser localStorage
  // semantics as the plan itself.
  const [deferred, setDeferred] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('recoupment_plan_deferred') || '[]')) } catch { return new Set() }
  })
  const toggleDeferred = (key) => setDeferred(prev => {
    const next = new Set(prev)
    next.has(key) ? next.delete(key) : next.add(key)
    localStorage.setItem('recoupment_plan_deferred', JSON.stringify([...next]))
    return next
  })
  const [committing, setCommitting] = useState(false)
  const [error, setError] = useState('')
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [moveMenuFor, setMoveMenuFor] = useState(null) // label key open on move menu
  // Invoice preview overlay — same FilePreview + parent-fallback rules
  // the Recoupments page uses (a split child's file lives on its parent).
  const [previewFile, setPreviewFile] = useState(null)
  const { rates: fxRates } = useFxRates()

  // Extracted so the split modal can refetch after a split reshapes the
  // family (parent stays as the first split, children added).
  const fetchEntries = async () => {
    setLoading(true)
    try {
      const res = await api.get('/bk/entries?status=approved&deleted=false')
      // Same exclusion as the Recoupments page — a statement row must not be
      // Same gate as Recoupments: bank-born rows are admitted ONCE REVIEWED. See
      // withoutUnreviewedBankRows in utils.js. If these two pages disagree about
      // which rows exist, a plan gets built from a set the page it came from does
      // not show.
      setEntries(withoutUnreviewedBankRows(Array.isArray(res.data?.data) ? res.data.data : []))
    } catch {
      setEntries([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchEntries() }, [])

  // Rehydrate on window focus — the Recoupments page can add more
  // items to the plan while this tab sits open.
  useEffect(() => {
    const rehydrate = () => setPlan(loadPlan())
    window.addEventListener('focus', rehydrate)
    return () => window.removeEventListener('focus', rehydrate)
  }, [])

  // The subset of the ledger that's actually in the plan. Filtered
  // to items still eligible (recoupable, not already UFR'd) — unpaid
  // items are allowed so the plan can be assembled ahead of payment;
  // the Paid/Unpaid pill on each row keeps the state visible. If an
  // item was marked UFR from another surface between selection and
  // now, we drop it from the plan display and prune the stale
  // localStorage entry.
  const planItems = useMemo(() => {
    const inPlanIds = new Set(Object.keys(plan).map(Number))
    const stale = []
    const out = []
    for (const e of entries) {
      if (!inPlanIds.has(e.id)) continue
      const eligible = (
        !!e.recoupable
        && (e.ufr !== 'Yes')
        && !e.deleted
        && !e.voided
      )
      if (eligible) out.push(e)
      else stale.push(e.id)
    }
    if (stale.length) {
      // Prune silently — no user-visible warning yet since stale
      // items are usually the result of the operator marking them
      // UFR elsewhere, which is a valid parallel workflow.
      const next = { ...plan }
      for (const id of stale) delete next[id]
      savePlan(next)
    }
    return out
  }, [entries, plan])

  // Group plan items by label. Unlabeled items land in a UNLABELED
  // bucket. Preserve insertion order of labels so a group the user
  // just created doesn't jump around on re-render.
  const groups = useMemo(() => {
    const byLabel = new Map()
    for (const it of planItems) {
      const label = plan[it.id] ?? ''
      if (!byLabel.has(label)) byLabel.set(label, [])
      byLabel.get(label).push(it)
    }
    // Sort items within a group by payment_date desc, artist asc
    for (const arr of byLabel.values()) {
      arr.sort((a, b) => {
        const pa = a.payment_date || a.invoice_date || ''
        const pb = b.payment_date || b.invoice_date || ''
        if (pa !== pb) return pb.localeCompare(pa)
        return (a.artist || '').localeCompare(b.artist || '')
      })
    }
    // Groups in display order: Unlabeled first, then rest in
    // alphabetical order for stability.
    const labels = Array.from(byLabel.keys()).sort((a, b) => {
      if (a === UNLABELED) return -1
      if (b === UNLABELED) return 1
      return a.localeCompare(b)
    })
    return labels.map(l => ({ label: l, items: byLabel.get(l) }))
  }, [planItems, plan])

  const allLabels = useMemo(() => (
    groups.map(g => g.label).filter(l => l !== UNLABELED)
  ), [groups])

  // Collapsible song sections + category buckets in the drill-down.
  // Keys include the artist so collapse state doesn't bleed between
  // artists when navigating back and forth.
  const [collapsedSongs, setCollapsedSongs] = useState(() => new Set())
  const [collapsedCats, setCollapsedCats] = useState(() => new Set())
  const toggleIn = (setter) => (key) => setter(prev => {
    const next = new Set(prev)
    next.has(key) ? next.delete(key) : next.add(key)
    return next
  })
  const toggleSongCollapse = toggleIn(setCollapsedSongs)
  const toggleCatCollapse = toggleIn(setCollapsedCats)

  // Parent lookup for split children — invoice files + socials live on
  // the parent row. `entries` holds the full approved ledger, so parents
  // are findable even when they aren't in the plan themselves.
  const entryById = useMemo(() => {
    const m = new Map()
    for (const e of entries) m.set(e.id, e)
    return m
  }, [entries])
  const hasInvoiceFile = (entry) => {
    if (entry.has_invoice) return true
    if (entry.parent_id) return !!entryById.get(entry.parent_id)?.has_invoice
    return false
  }
  const invoiceUrl = (entry) => {
    // Prefer the row's OWN file — a split child with its own attached
    // invoice used to open the parent's document (or 404).
    const id = (!entry.has_invoice && entry.parent_id) ? entry.parent_id : entry.id
    return `/api/bk/entries/${id}/file/invoice?token=${localStorage.getItem('token')}`
  }
  const rowSocials = (entry) => {
    const own = socialsList(entry.social_handles)
    if (own.length) return own
    if (entry.parent_id) return socialsList(entryById.get(entry.parent_id)?.social_handles)
    return []
  }

  // ── Artist cards → song → category drill-down ───────────────────────────
  // Top level shows one card per artist with planned items; clicking in
  // shows that artist's items grouped by song, then by category within
  // each song — mirroring the Recoupments / Campaigns grouping.
  // URL-backed (?artist=<key>) so the Recoupments artist page can link
  // straight into an artist's planning detail — and back.
  const [searchParams, setSearchParams] = useSearchParams()
  const [selectedArtist, setSelectedArtistState] = useState(
    () => (searchParams.get('artist') || '').trim().toLowerCase() || null
  )
  const setSelectedArtist = (key) => {
    setSelectedArtistState(key)
    setSearchParams(key ? { artist: key } : {}, { replace: true })
  }

  // ?focus=<expenseId> deep link — the Ledger links staged rows here.
  // Auto-selects the item's artist, scrolls the row into view, and
  // spotlights it briefly (same pattern as the Ledger's own ?focus=).
  const [focusId, setFocusId] = useState(() => Number(searchParams.get('focus')) || null)
  useEffect(() => {
    if (loading || !focusId) return
    const item = planItems.find(e => e.id === focusId)
    if (!item) { setFocusId(null); return }
    const key = (item.artist || '').trim().toLowerCase() || '__noartist__'
    if (selectedArtist !== key) { setSelectedArtist(key); return }
    const el = document.getElementById(`plan-item-${focusId}`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    const t = setTimeout(() => setFocusId(null), 3200)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, focusId, planItems, selectedArtist])

  const artistGroups = useMemo(() => {
    const by = new Map()
    for (const it of planItems) {
      const key = (it.artist || '').trim().toLowerCase() || '__noartist__'
      if (!by.has(key)) by.set(key, { key, items: [], spellings: {} })
      const b = by.get(key)
      b.items.push(it)
      const raw = (it.artist || '').trim() || '(no artist)'
      b.spellings[raw] = (b.spellings[raw] || 0) + 1
    }
    return Array.from(by.values())
      .map(b => ({
        key: b.key,
        items: b.items,
        // Best spelling wins — same rule artist names use app-wide.
        name: Object.entries(b.spellings).sort((a, c) => c[1] - a[1])[0][0],
        totals: sumByCurrency(b.items),
        unlabeled: b.items.filter(i => (plan[i.id] ?? '') === '').length,
      }))
      .sort((a, c) => (totalsToUsd(c.totals, fxRates) || 0) - (totalsToUsd(a.totals, fxRates) || 0))
  }, [planItems, plan, fxRates])

  const currentArtist = selectedArtist
    ? artistGroups.find(a => a.key === selectedArtist) || null
    : null

  // Labels offered in the pickers — scoped to the drilled-in artist so
  // one artist's labels don't clutter another's menus. The cards view
  // (cross-artist selection) still sees every plan label.
  const visibleLabels = useMemo(() => {
    if (!currentArtist) return allLabels
    return [...new Set(currentArtist.items.map(i => plan[i.id] || '').filter(Boolean))].sort()
  }, [currentArtist, allLabels, plan])

  // Drill-down grouping mode: by song (song → category, the default) or
  // by label. Label sections borrow the song-section SHAPE (one pseudo-
  // category holding all items) so the same renderer serves both.
  const [groupMode, setGroupMode] = useState('song')
  const labelSections = useMemo(() => {
    if (!currentArtist) return []
    const by = new Map()
    for (const it of currentArtist.items) {
      const l = plan[it.id] || ''
      if (!by.has(l)) by.set(l, [])
      by.get(l).push(it)
    }
    const sections = [...by.entries()].map(([l, items]) => {
      const sorted = [...items].sort((a, c) =>
        (c.payment_date || c.invoice_date || '').localeCompare(a.payment_date || a.invoice_date || ''))
      const totals = sumByCurrency(sorted)
      return {
        key: `__label__${l || '__unlabeled__'}`,
        song: l || '(unlabeled)',
        isLabel: true,
        isUnlabeled: !l,
        count: sorted.length,
        totals,
        categories: [{ cat: '__ALL__', totals, items: sorted }],
      }
    })
    // Unlabeled first — it's the to-do bucket — then alphabetical.
    return sections.sort((a, c) => {
      if (a.isUnlabeled) return -1
      if (c.isUnlabeled) return 1
      return a.song.localeCompare(c.song)
    })
  }, [currentArtist, plan])

  // Bounce back to the cards when the selected artist's last item
  // leaves the plan (removed / committed elsewhere). Waits for the
  // entries fetch so a deep-linked ?artist= isn't bounced before the
  // plan items hydrate.
  useEffect(() => {
    if (!loading && selectedArtist && !artistGroups.some(a => a.key === selectedArtist)) {
      setSelectedArtist(null)
    }
  }, [loading, selectedArtist, artistGroups])

  const songSections = useMemo(() => {
    if (!currentArtist) return []
    const bySong = new Map()
    for (const it of currentArtist.items) {
      const raw = (it.song || '').trim()
      const key = raw.toLowerCase() || '__nosong__'
      if (!bySong.has(key)) bySong.set(key, { key, song: raw || '(no song)', cats: new Map() })
      const s = bySong.get(key)
      const cat = (it.category || '').trim() || 'Uncategorized'
      if (!s.cats.has(cat)) s.cats.set(cat, [])
      s.cats.get(cat).push(it)
    }
    const sections = Array.from(bySong.values()).map(s => {
      const all = Array.from(s.cats.values()).flat()
      return {
        key: s.key,
        song: s.song,
        count: all.length,
        totals: sumByCurrency(all),
        categories: Array.from(s.cats.entries())
          .sort((a, c) => a[0].localeCompare(c[0]))
          .map(([cat, items]) => ({
            cat,
            totals: sumByCurrency(items),
            items: [...items].sort((a, c) =>
              (c.payment_date || c.invoice_date || '').localeCompare(a.payment_date || a.invoice_date || '')),
          })),
      }
    })
    // (no song) sinks to the bottom; the rest sort by spend desc.
    return sections.sort((a, c) => {
      if (a.key === '__nosong__') return 1
      if (c.key === '__nosong__') return -1
      return (totalsToUsd(c.totals, fxRates) || 0) - (totalsToUsd(a.totals, fxRates) || 0)
    })
  }, [currentArtist, fxRates])

  // Plan minus saved-for-later artists — what Done actually commits and
  // what the headline numbers describe.
  const planArtistKey = (it) => (it.artist || '').trim().toLowerCase() || '__noartist__'
  const activePlanItems = useMemo(
    () => planItems.filter(it => !deferred.has(planArtistKey(it))),
    [planItems, deferred]
  )

  const totalsAll = sumByCurrency(activePlanItems)
  const totalUsd = totalsToUsd(totalsAll, fxRates)

  const toggleSelect = (id) => setSelectedIds(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })
  const clearSelection = () => setSelectedIds(new Set())
  // Toggle-select every item in a song/category bucket (drill-down view).
  const selectItems = (items) => setSelectedIds(prev => {
    const ids = items.map(i => i.id)
    const allSelected = ids.every(id => prev.has(id))
    const next = new Set(prev)
    if (allSelected) { for (const id of ids) next.delete(id) }
    else             { for (const id of ids) next.add(id) }
    return next
  })

  // Per-expense flag-for-review — same column + endpoint the Recoupments /
  // Campaigns / Ledger flags write, so a flag raised here is visible
  // everywhere the row appears.
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

  // ── Row actions (mirroring Recoupments.jsx) ─────────────────────────────
  // All update `entries` optimistically; planItems derives from entries +
  // plan and auto-prunes rows that become ineligible, so un-recouping /
  // UFR-ing / deleting a row drops it from the plan display for free.
  const [savingId, setSavingId] = useState(null)
  const [deletingId, setDeletingId] = useState(null)

  // Toggle recoupable. Optimistic update with rollback on failure.
  const toggleRecoupable = async (id, currentRecoupable) => {
    const newVal = !currentRecoupable
    setSavingId(id)
    setEntries(prev => prev.map(e => e.id === id ? { ...e, recoupable: newVal } : e))
    try {
      await api.put(`/bk/entries/${id}`, { recoupable: newVal })
    } catch {
      setEntries(prev => prev.map(e => e.id === id ? { ...e, recoupable: currentRecoupable } : e))
    } finally { setSavingId(null) }
  }

  const toggleUfr = async (id, currentUfr) => {
    const newVal = currentUfr === 'Yes' ? 'No' : 'Yes'
    setSavingId(id)
    try {
      // Flipping to Yes carries the item's assigned plan label — the bulk
      // Done path writes it, and this per-row button used to silently drop
      // it, landing the item on the statement unlabeled.
      const body = newVal === 'Yes'
        ? { ufr: newVal, recoupment_label: plan[id] || null }
        : { ufr: newVal }
      await api.put(`/bk/entries/${id}`, body)
      setEntries(prev => prev.map(e => e.id === id ? { ...e, ufr: newVal, ...(newVal === 'Yes' ? { recoupment_label: plan[id] || null } : null) } : e))
    } catch {} finally { setSavingId(null) }
  }

  // Toggle the cobrand flag on a single expense. Optimistic — flip in
  // local state, PUT, rollback on failure. Mirrors toggleRecoupable.
  const toggleCobrand = async (id, current) => {
    const next = !current
    setSavingId(id)
    // Server forces category=Marketing when cobrand flips on — mirror
    // locally, and remember the previous category so rollback restores it.
    const prevCategory = entries.find(e => e.id === id)?.category
    const patchOn = next ? { category: 'Marketing' } : {}
    setEntries(prev => prev.map(e => e.id === id ? { ...e, cobrand: next, ...patchOn } : e))
    try {
      await api.put(`/bk/entries/${id}`, { cobrand: next })
    } catch {
      setEntries(prev => prev.map(e => e.id === id ? { ...e, cobrand: current, ...(next ? { category: prevCategory } : {}) } : e))
    } finally { setSavingId(null) }
  }

  // Soft-delete an expense (server cascades to split-family children;
  // restore is available from the Ledger). Removes the row from entries
  // and prunes it from the plan; refetch on failure.
  const handleDeleteEntry = async (entry) => {
    if (!window.confirm(`Delete ${entry.payee || 'this entry'}? It will be soft-deleted — you can restore it later from the Ledger.`)) return
    setDeletingId(entry.id)
    try {
      await api.delete(`/bk/entries/${entry.id}`)
      setEntries(prev => prev.filter(e => e.id !== entry.id))
      setPlan(removeFromPlan([entry.id]))
    } catch (err) {
      alert('Failed to delete: ' + (err.response?.data?.error || err.message))
      fetchEntries()
    } finally {
      setDeletingId(null)
    }
  }

  // Bulk "Set song" — prompt for the song name, PUT it on every selected
  // row in parallel, then patch local state. Mirrors Recoupments' bulk
  // song setter, prompt-based like the label creator above.
  const bulkSetSong = async () => {
    if (!selectedIds.size) return
    const ids = Array.from(selectedIds)
    const raw = window.prompt(`Set song for ${ids.length} item${ids.length === 1 ? '' : 's'} (leave blank to clear):`, '')
    if (raw === null) return
    const next = raw.trim()
    try {
      await Promise.all(ids.map(id => api.put(`/bk/entries/${id}`, { song: next || null })))
      setEntries(p => p.map(e => ids.includes(e.id) ? { ...e, song: next || null } : e))
      clearSelection()
    } catch (err) {
      alert('Failed to update song: ' + (err.response?.data?.error || err.message))
    }
  }

  // Split modal — divides one expense into N artist-specific child rows
  // via POST /bk/entries/:id/split. Same shape the Recoupments page uses;
  // pre-fills with the current artist + one blank row, amount distributed
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

  // Inline comment strips — bulk-fetched in ONE request for every planned
  // row that has comments (the entries payload only carries the count),
  // then kept live by CommentThreadButton's onThreadChange callback.
  const [commentsByEntry, setCommentsByEntry] = useState({})
  useEffect(() => {
    const ids = planItems
      .filter(e => (Number(e.comment_count) || 0) > 0 && !(e.id in commentsByEntry))
      .map(e => e.id)
    if (!ids.length) return
    api.get(`/bk/comments?ids=${ids.join(',')}`)
      .then(r => {
        const by = {}
        for (const id of ids) by[id] = []
        for (const c of (r.data?.data || [])) (by[c.expense_id] = by[c.expense_id] || []).push(c)
        setCommentsByEntry(prev => ({ ...prev, ...by }))
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planItems])
  const onThreadChange = (entryId, thread) =>
    setCommentsByEntry(prev => ({ ...prev, [entryId]: thread }))

  // Per-item label editor — anchored menu offering every existing label
  // plus a new-label input, so reusing "Distant Matter - Vivid Nostalgia
  // shoot" is one click instead of retyping it. Portal + fixed position
  // (same clipping-proof pattern as the flag/comment popovers).
  const [labelMenu, setLabelMenu] = useState(null) // { id, current, top, left }
  const [labelDraft, setLabelDraft] = useState('')
  const openLabelMenu = (e, id, current) => {
    e.stopPropagation()
    const r = e.currentTarget.getBoundingClientRect()
    const width = 240
    setLabelDraft('')
    setLabelMenu({
      id,
      current: current || '',
      top: Math.min(r.bottom + 6, window.innerHeight - 80),
      left: Math.min(Math.max(8, r.left), window.innerWidth - width - 8),
    })
  }
  const applyLabel = (label) => {
    if (!labelMenu) return
    setPlan(setLabelForItems([labelMenu.id], (label || '').trim()))
    setLabelMenu(null)
  }

  const removeItem = (id) => {
    setPlan(removeFromPlan([id]))
    setSelectedIds(prev => { const n = new Set(prev); n.delete(id); return n })
  }
  const removeSelected = () => {
    if (!selectedIds.size) return
    setPlan(removeFromPlan(Array.from(selectedIds)))
    clearSelection()
  }
  // Move selected items to a label. If label is empty, they become
  // unlabeled. If it's a new string, a new group appears.
  const moveSelectedTo = (label) => {
    if (!selectedIds.size) return
    setPlan(setLabelForItems(Array.from(selectedIds), label))
    clearSelection()
    setMoveMenuFor(null)
  }

  // Prompt-based label creation / rename. Simple; a modal-based
  // editor is a follow-up if the prompt UX gets in the way.
  const createGroupFromSelected = () => {
    if (!selectedIds.size) return
    const label = (window.prompt('New label / group name:', '') || '').trim()
    if (!label) return
    moveSelectedTo(label)
  }
  // Mass upload for the SELECTED items only — same per-item PUT as the
  // full Done commit (ufr='Yes' + assigned label), but scoped to the
  // checkbox selection so a partial batch can go out without committing
  // the whole plan. Committed ids leave the plan; everything else stays.
  const [committingSelected, setCommittingSelected] = useState(false)
  const commitSelected = async () => {
    const items = planItems.filter(it => selectedIds.has(it.id))
    if (!items.length || committingSelected || committing) return
    const msg = `Mark ${items.length} selected item${items.length === 1 ? '' : 's'} as UFR now?\n\n`
      + `They'll land on this month's statement tab with their assigned labels. The rest of the plan stays staged.`
    if (!window.confirm(msg)) return
    setCommittingSelected(true)
    setError('')
    try {
      const CONCURRENCY = 6
      const queue = [...items]
      const failures = []
      const worker = async () => {
        while (queue.length) {
          const it = queue.shift()
          const label = plan[it.id] ?? ''
          try {
            await api.put(`/bk/entries/${it.id}`, { ufr: 'Yes', recoupment_label: label || null })
          } catch (err) {
            failures.push({ id: it.id, payee: it.payee, err: err?.response?.data?.error || err.message })
          }
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, worker))
      const failedIds = new Set(failures.map(f => f.id))
      const doneIds = items.map(i => i.id).filter(id => !failedIds.has(id))
      // Committed items leave the plan; UFR flips locally so planItems'
      // eligibility filter drops them without a refetch.
      setPlan(prev => {
        const next = {}
        for (const [k, v] of Object.entries(prev)) {
          if (!doneIds.includes(Number(k))) next[k] = v
        }
        savePlan(next)
        return next
      })
      setEntries(prev => prev.map(e => doneIds.includes(e.id) ? { ...e, ufr: 'Yes' } : e))
      clearSelection()
      if (failures.length) {
        const sample = failures.slice(0, 3).map(f => `#${f.id} ${f.payee || ''} — ${f.err}`).join('\n')
        setError(`${failures.length} item${failures.length === 1 ? '' : 's'} failed:\n${sample}${failures.length > 3 ? '\n…' : ''}`)
      }
    } catch (err) {
      setError('Unexpected error: ' + (err?.response?.data?.error || err.message))
    } finally {
      setCommittingSelected(false)
    }
  }

  const resetPlan = () => {
    if (!planSize(plan)) return
    if (!window.confirm(`Discard the entire plan (${planSize(plan)} item${planSize(plan) === 1 ? '' : 's'})? Items stay on the ledger — this just clears the working set.`)) return
    clearPlan()
    setPlan({})
    clearSelection()
  }

  // Done: mark every planned item UFR now, stamping the assigned
  // label on the way. Uses the existing per-item PUT endpoint in a
  // parallel batch so per-item audit + auto-cascades fire correctly.
  // On success, clears the plan and navigates back to Recoupments.
  const commit = async () => {
    if (!activePlanItems.length || committing) return
    const deferredCount = planItems.length - activePlanItems.length
    const msg = `Mark ${activePlanItems.length} item${activePlanItems.length === 1 ? '' : 's'} as UFR now?\n\n`
      + `They'll land on this month's statement tab. Labels will be applied to each item.`
      + (deferredCount > 0 ? `\n\n(${deferredCount} item${deferredCount === 1 ? '' : 's'} saved for later stay in the plan.)` : '')
    if (!window.confirm(msg)) return
    setCommitting(true)
    setError('')
    try {
      // Fire in parallel but bounded — 6-way concurrency keeps the
      // server happy while still finishing a 50-item plan in a few
      // seconds. Any single failure surfaces to the operator; the
      // plan stays intact so they can retry.
      const CONCURRENCY = 6
      const queue = [...activePlanItems]
      const failures = []
      const worker = async () => {
        while (queue.length) {
          const it = queue.shift()
          const label = plan[it.id] ?? ''
          try {
            await api.put(`/bk/entries/${it.id}`, {
              ufr: 'Yes',
              recoupment_label: label || null,
            })
          } catch (err) {
            failures.push({ id: it.id, payee: it.payee, err: err?.response?.data?.error || err.message })
          }
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, worker))
      if (failures.length) {
        const sample = failures.slice(0, 3).map(f => `#${f.id} ${f.payee || ''} — ${f.err}`).join('\n')
        setError(`${failures.length} item${failures.length === 1 ? '' : 's'} failed:\n${sample}${failures.length > 3 ? '\n…' : ''}`)
        // Prune only the items we actually committed successfully — keep
        // failed ones for retry AND everything that was never in this
        // commit (saved-for-later artists). The old version kept only the
        // failures, silently wiping every deferred artist's staged batch.
        const failedIds = new Set(failures.map(f => f.id))
        const committedIds = new Set(activePlanItems.map(i => i.id))
        setPlan(prev => {
          const next = {}
          for (const [k, v] of Object.entries(prev)) {
            const id = Number(k)
            if (failedIds.has(id) || !committedIds.has(id)) next[k] = v
          }
          savePlan(next)
          return next
        })
      } else if (planItems.length > activePlanItems.length) {
        // Saved-for-later items stay in the plan — remove only what we
        // just committed and stay on the page so the remainder is visible.
        const committedIds = new Set(activePlanItems.map(i => i.id))
        setPlan(prev => {
          const next = {}
          for (const [k, v] of Object.entries(prev)) {
            if (!committedIds.has(Number(k))) next[k] = v
          }
          savePlan(next)
          return next
        })
        clearSelection()
      } else {
        clearPlan()
        setPlan({})
        // Head back to the Recoupments page — the current month's
        // statement tab is now populated with everything we just UFR'd.
        navigate('/recoupments')
      }
    } catch (err) {
      setError('Unexpected error: ' + (err?.response?.data?.error || err.message))
    } finally {
      setCommitting(false)
    }
  }

  // Copy plan to clipboard as a plain-text outline (kept from prior
  // iteration — the "email the plan out" affordance is still useful
  // before committing).
  const [copyState, setCopyState] = useState('')
  const copyList = async () => {
    if (!planItems.length) return
    const lines = ['Planned for next Tone upload:', '']
    for (const g of groups) {
      const gTotals = sumByCurrency(g.items)
      const header = g.label === UNLABELED
        ? `Unlabeled — ${g.items.length} item${g.items.length === 1 ? '' : 's'} · ${fmtTotals(gTotals)}`
        : `${g.label} — ${g.items.length} item${g.items.length === 1 ? '' : 's'} · ${fmtTotals(gTotals)}`
      lines.push(header)
      for (const it of g.items) {
        const date = it.payment_date ? `paid ${formatDate(it.payment_date)}` : (it.invoice_date ? formatDate(it.invoice_date) : '(no date)')
        const song = it.song ? ` · ${it.song}` : ''
        lines.push(`  • ${it.artist || '—'} · ${it.payee || '—'}${song} · ${fmtMoney(it.amount, it.currency || 'USD')} · ${date}`)
      }
      lines.push('')
    }
    lines.push(`Total: ${planItems.length} item${planItems.length === 1 ? '' : 's'} — ${fmtTotals(sumByCurrency(planItems))}`)
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      setCopyState('copied')
      setTimeout(() => setCopyState(''), 2000)
    } catch {
      window.prompt('Copy plan text:', lines.join('\n'))
    }
  }

  return (
    <div className="space-y-5">
      <Link
        to="/recoupments"
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-gray-600 hover:text-gray-900 bg-white border border-rule hover:border-gray-300"
      >
        <ArrowLeft size={13} /> Back to Recoupments
      </Link>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <PageHeader tour="planning-header"
            title="Recoupment planning"
            subtitle="Group + label the items you're planning to upload. Click Done to mark them UFR — they'll land on this month's statement tab automatically."
          />
        </div>
        <div data-tour="planning-actions" className="flex items-center gap-2 pt-1 flex-wrap">
          <button
            onClick={copyList}
            disabled={!planItems.length}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-gray-700 bg-white border border-rule hover:border-gray-300 disabled:opacity-40"
          >
            {copyState === 'copied' ? <Check size={12} className="text-emerald-500" /> : <Tag size={12} />}
            {copyState === 'copied' ? 'Copied' : 'Copy list'}
          </button>
          <button
            onClick={resetPlan}
            disabled={!planItems.length || committing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-rose-600 bg-white border border-rose-200 hover:bg-rose-50 disabled:opacity-40"
          >
            <RotateCcw size={12} /> Reset plan
          </button>
          <button
            onClick={commit}
            disabled={!activePlanItems.length || committing}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 shadow-sm"
            title={activePlanItems.length
              ? `Mark ${activePlanItems.length} item${activePlanItems.length === 1 ? '' : 's'} UFR now${planItems.length > activePlanItems.length ? ` — ${planItems.length - activePlanItems.length} saved for later stay in the plan` : ''}`
              : 'Add items from the Recoupments Pending tab first'}
          >
            {committing ? <Loader size={13} className="animate-spin" /> : <Check size={13} />}
            {committing ? 'Committing…' : `Done · Mark ${activePlanItems.length} UFR`}
          </button>
        </div>
      </div>

      {/* Top summary strip — scoped to the drilled-in artist when one is
          selected, so the big numbers always describe what's on screen
          (the whole plan reads as "total overall" from inside a
          drill-down). The Done button stays plan-wide by design and
          says so with its own count. */}
      {(() => {
        const stripItems = currentArtist ? currentArtist.items : activePlanItems
        const stripTotals = currentArtist ? currentArtist.totals : totalsAll
        const stripUsd = currentArtist ? totalsToUsd(stripTotals, fxRates) : totalUsd
        const labelSet = new Set()
        let stripUnlabeled = 0
        for (const it of stripItems) {
          const l = plan[it.id] || ''
          if (l) labelSet.add(l); else stripUnlabeled++
        }
        return (
      <div data-tour="planning-summary" className="card px-5 py-4 flex items-baseline gap-6 flex-wrap">
        <div>
          <p className="text-[10px] uppercase tracking-wider font-semibold text-gray-400">
            In plan{currentArtist ? ` · ${currentArtist.name}` : ''}
          </p>
          <p className="text-2xl font-black text-gray-900 tabular-nums mt-1">{stripItems.length}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider font-semibold text-gray-400">Groups</p>
          <p className="text-2xl font-black text-gray-900 tabular-nums mt-1">
            {labelSet.size}
            {stripUnlabeled > 0 && (
              <span className="text-sm font-semibold text-amber-600 ml-2">
                + {stripUnlabeled} unlabeled
              </span>
            )}
          </p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider font-semibold text-gray-400">Total</p>
          <p className={`font-black text-emerald-700 tabular-nums mt-1 ${Object.keys(stripTotals).length > 1 ? 'text-base' : 'text-2xl'}`}>
            {stripItems.length ? fmtTotals(stripTotals) : <span className="text-gray-300 text-2xl">—</span>}
          </p>
        </div>
        {/* Converted grand total — THE number the batch settles at, so it
            gets its own top-billing cell whenever FX rates are loaded. */}
        {stripUsd != null && stripItems.length > 0 && (
          <div>
            <p className="text-[10px] uppercase tracking-wider font-semibold text-gray-400">Total (USD)</p>
            <p className="text-2xl font-black text-emerald-700 tabular-nums mt-1">
              {Object.keys(stripTotals).length > 1 ? '≈ ' : ''}{fmtMoney(stripUsd, 'USD')}
            </p>
          </div>
        )}
      </div>
        )
      })()}

      {/* Page notes — planning-workflow scratchpad, saves on blur. */}
      <div className="card p-4">
        <div className="flex items-center gap-2 mb-2">
          <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider">Notes</h3>
          {pageNoteSaving && <span className="text-[10px] text-gray-400 italic">saving…</span>}
        </div>
        <textarea
          value={pageNote}
          onChange={e => setPageNote(e.target.value.slice(0, 4000))}
          onBlur={savePageNote}
          placeholder="Batch context — what this upload covers, blockers, items waiting on invoices, anything the next person working the plan should know."
          rows={3}
          className="w-full text-sm rounded border border-rule bg-transparent px-3 py-2 focus:outline-none focus:ring-2 focus:ring-boom-500/40 resize-y"
          style={{ fontFamily: 'inherit', lineHeight: 1.5 }}
        />
        <div className="text-[10px] text-gray-400 text-right mt-1">
          {pageNote.length}/4000 · saves on blur
        </div>
      </div>

      {error && (
        <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded px-3 py-2 whitespace-pre-line">
          {error}
        </div>
      )}

      {/* Multi-select action bar */}
      {selectedIds.size > 0 && (
        <div
          className="fixed bottom-20 sm:bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 flex-wrap justify-center bg-[#111827] text-white rounded-xl shadow-2xl px-4 sm:px-5 py-3 max-w-[calc(100vw-1.5rem)]"
          style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
        >
          <span className="text-sm font-bold">{selectedIds.size} selected</span>
          {/* Selection total — per-currency, with the ≈USD conversion
              when rates are loaded (matches the header strip's math). */}
          {(() => {
            const sel = planItems.filter(it => selectedIds.has(it.id))
            if (!sel.length) return null
            const totals = sumByCurrency(sel)
            const usd = totalsToUsd(totals, fxRates)
            return (
              <span className="text-sm font-bold text-emerald-300 tabular-nums">
                {fmtTotals(totals)}
                {usd != null && Object.keys(totals).length > 1 && (
                  <span className="text-white/50 font-semibold"> ≈ {fmtMoney(usd, 'USD')}</span>
                )}
              </span>
            )
          })()}
          <div className="w-px h-5 bg-white/15 mx-1" />
          <div className="relative">
            <button
              onClick={() => setMoveMenuFor(moveMenuFor === '__bulk__' ? null : '__bulk__')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-white/10 hover:bg-white/20"
            >
              <MoveRight size={12} /> Move to label <ChevronDown size={10} />
            </button>
            {moveMenuFor === '__bulk__' && (
              <div className="absolute bottom-full mb-2 right-0 bg-white text-gray-900 rounded-lg shadow-lg border border-rule py-1 min-w-[220px] max-h-64 overflow-y-auto">
                <button
                  onClick={() => moveSelectedTo('')}
                  className="w-full px-3 py-1.5 text-left text-xs hover:bg-gray-50"
                >Unlabeled</button>
                {visibleLabels.map(l => (
                  <button
                    key={l}
                    onClick={() => moveSelectedTo(l)}
                    className="w-full px-3 py-1.5 text-left text-xs hover:bg-gray-50 truncate"
                  >{l}</button>
                ))}
                <div className="border-t border-divider my-1" />
                <button
                  onClick={createGroupFromSelected}
                  className="w-full px-3 py-1.5 text-left text-xs font-semibold text-boom-700 hover:bg-boom-50"
                >
                  <Plus size={11} className="inline mr-1" /> New label…
                </button>
              </div>
            )}
          </div>
          <button
            onClick={bulkSetSong}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-white/10 hover:bg-white/20"
          >
            <Music2 size={12} /> Set song…
          </button>
          {/* Mass upload — UFR just the selected items, plan keeps the rest. */}
          <button
            onClick={commitSelected}
            disabled={committingSelected}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-500/90 hover:bg-emerald-500 transition-colors disabled:opacity-50"
            title="Mark the selected items UFR now — they land on this month's statement; the rest of the plan stays staged"
          >
            {committingSelected ? <Loader size={12} className="animate-spin" /> : <Upload size={12} />}
            {committingSelected ? 'Uploading…' : `Mark ${selectedIds.size} UFR`}
          </button>
          <button
            onClick={removeSelected}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-rose-500/90 hover:bg-rose-500 transition-colors"
          >
            <X size={12} /> Remove from plan
          </button>
          <button
            onClick={clearSelection}
            className="text-xs font-semibold text-white/60 hover:text-white px-2 py-1"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Body */}
      {loading ? (
        <div data-tour="planning-body" className="card p-12 text-center text-sm text-gray-500 flex items-center justify-center gap-2">
          <Loader size={14} className="animate-spin" /> Loading plan…
        </div>
      ) : planItems.length === 0 ? (
        <div className="card p-16 text-center">
          <div className="w-14 h-14 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-4">
            <Tag size={20} className="text-gray-400" />
          </div>
          <p className="text-sm font-semibold text-gray-900">No items in the plan yet.</p>
          <p className="text-xs text-gray-500 mt-1 max-w-md mx-auto">
            Head to <Link to="/recoupments" className="text-boom-600 font-semibold hover:text-boom-700">Recoupments</Link>,
            select items in the <strong>Pending</strong> section, and click <strong>Add to plan</strong> in
            the multi-select bar. They'll show up here for grouping + labeling.
          </p>
        </div>
      ) : !currentArtist ? (
        /* ── Artist cards ─────────────────────────────────────────────── */
        <div className="space-y-3">
          <div className="flex justify-end">
            <button
              onClick={() => selectItems(activePlanItems)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-gray-700 bg-card border border-rule hover:border-gray-300"
            >
              {activePlanItems.length > 0 && activePlanItems.every(i => selectedIds.has(i.id))
                ? 'Clear selection'
                : `Select all (${activePlanItems.length})`}
            </button>
          </div>
          {(() => {
            // "Save for later" partition — deferred artists group in their
            // own muted section at the bottom and sit out the Done commit.
            const activeCards   = artistGroups.filter(a => !deferred.has(a.key))
            const deferredCards = artistGroups.filter(a =>  deferred.has(a.key))
            const renderCard = (a, isDeferred) => (
              <button
                key={a.key}
                onClick={() => setSelectedArtist(a.key)}
                className={`card p-4 text-left hover:border-boom-300 hover:shadow-sm transition-all group relative ${isDeferred ? 'opacity-70 border-dashed' : ''}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-bold text-gray-900 truncate">{a.name}</h3>
                  <span className="inline-flex items-center gap-1 shrink-0">
                    {/* Artist flag — shared artist_meta.flagged, so a flag
                        raised here shows on Recoupments / Campaigns too. */}
                    <span onClick={e => { e.preventDefault(); e.stopPropagation() }} className="inline-flex">
                      <FlagButton
                        flagged={!!metaForArtist(a.name).flagged}
                        reason={metaForArtist(a.name).flag_reason || ''}
                        flaggedBy={metaForArtist(a.name).flagged_by_name || ''}
                        flaggedAt={metaForArtist(a.name).flagged_at}
                        onToggle={(next, reason) => setArtistFlag(a.name, next, reason ?? null)}
                        onSaveReason={(reason) => saveArtistFlagReason(a.name, reason)}
                        size="sm"
                        alwaysVisible
                      />
                    </span>
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={e => { e.preventDefault(); e.stopPropagation(); toggleDeferred(a.key) }}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleDeferred(a.key) } }}
                      className={`p-1 rounded transition-colors ${
                        isDeferred
                          ? 'text-violet-600 bg-violet-50 hover:bg-violet-100'
                          : 'text-gray-300 hover:text-violet-600 hover:bg-violet-50'
                      }`}
                      title={isDeferred
                        ? 'Saved for later — click to bring back into this batch'
                        : "Save for later — set this artist aside; their items stay staged but won't be committed with Done"}
                    >
                      <Bookmark size={13} fill={isDeferred ? 'currentColor' : 'none'} />
                    </span>
                    <ChevronRight size={14} className="text-gray-300 group-hover:text-boom-500" />
                  </span>
                </div>
                <p className="text-lg font-black text-emerald-700 tabular-nums mt-1">{fmtTotals(a.totals)}</p>
                {Object.keys(a.totals).length > 1 && totalsToUsd(a.totals, fxRates) != null && (
                  <p className="text-[11px] font-semibold text-gray-500 tabular-nums">≈ {fmtMoney(totalsToUsd(a.totals, fxRates), 'USD')}</p>
                )}
                <p className="text-[11px] text-gray-500 mt-0.5">
                  {a.items.length} item{a.items.length === 1 ? '' : 's'} staged
                  {a.unlabeled > 0 && (
                    <span className="text-amber-600 font-semibold"> · {a.unlabeled} unlabeled</span>
                  )}
                </p>
              </button>
            )
            const deferredTotals = sumByCurrency(deferredCards.flatMap(a => a.items))
            return (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {activeCards.map(a => renderCard(a, false))}
                </div>
                {activeCards.length === 0 && deferredCards.length > 0 && (
                  <p className="text-xs text-gray-400 italic text-center py-4">
                    Everything staged is saved for later — bring an artist back to commit a batch.
                  </p>
                )}
                {deferredCards.length > 0 && (
                  <div className="pt-2 space-y-3">
                    <div className="flex items-center gap-2 border-t border-divider pt-4">
                      <Bookmark size={13} className="text-violet-500" />
                      <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider">Saved for later</h3>
                      <span className="text-[11px] text-gray-400 tabular-nums">
                        {deferredCards.length} artist{deferredCards.length === 1 ? '' : 's'} · {deferredCards.reduce((s, a) => s + a.items.length, 0)} items · {fmtTotals(deferredTotals)}
                      </span>
                      <span className="text-[10px] text-gray-400 ml-auto">excluded from Done — click the bookmark to bring back</span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      {deferredCards.map(a => renderCard(a, true))}
                    </div>
                  </div>
                )}
              </>
            )
          })()}
        </div>
      ) : (
        /* ── Artist detail: song → category ───────────────────────────── */
        <div className="space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={() => setSelectedArtist(null)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-gray-600 hover:text-gray-900 bg-card border border-rule hover:border-gray-300"
            >
              <ArrowLeft size={13} /> All artists
            </button>
            <h2 className="text-base font-bold text-gray-900">{currentArtist.name}</h2>
            <span className="text-xs font-bold text-emerald-700 tabular-nums">
              {currentArtist.items.length} item{currentArtist.items.length === 1 ? '' : 's'} · {fmtTotals(currentArtist.totals)}
              {Object.keys(currentArtist.totals).length > 1 && totalsToUsd(currentArtist.totals, fxRates) != null && (
                <span className="text-gray-500 font-semibold"> (≈ {fmtMoney(totalsToUsd(currentArtist.totals, fxRates), 'USD')})</span>
              )}
            </span>
            <div className="ml-auto flex items-center gap-2">
              {/* Grouping mode — song → category vs label buckets. */}
              <div className="inline-flex rounded-lg border border-rule overflow-hidden text-xs font-semibold">
                <button
                  onClick={() => setGroupMode('song')}
                  className={groupMode === 'song' ? 'px-3 py-1.5 bg-boom-600 text-white' : 'px-3 py-1.5 bg-card text-gray-600 hover:bg-gray-50'}
                >
                  By song
                </button>
                <button
                  onClick={() => setGroupMode('label')}
                  className={groupMode === 'label' ? 'px-3 py-1.5 bg-boom-600 text-white' : 'px-3 py-1.5 bg-card text-gray-600 hover:bg-gray-50'}
                >
                  By label
                </button>
              </div>
              <button
                onClick={() => selectItems(currentArtist.items)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-gray-700 bg-card border border-rule hover:border-gray-300"
              >
                {currentArtist.items.every(i => selectedIds.has(i.id))
                  ? 'Clear selection'
                  : `Select all (${currentArtist.items.length})`}
              </button>
              {/* Round-trip companion to the Planning link on the artist's
                  Recoupments page. */}
              <Link
                to={`/recoupments/${encodeURIComponent(currentArtist.name)}`}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-gray-700 bg-card border border-rule hover:bg-gray-50 hover:border-gray-300"
                title="Open this artist's Recoupments page"
              >
                <FolderOpen size={13} /> Recoupments page
              </Link>
            </div>
          </div>

          {(groupMode === 'song' ? songSections : labelSections).map(sec => {
            const songKey = `${selectedArtist}::${sec.key}`
            const songCollapsed = collapsedSongs.has(songKey)
            return (
            <div key={sec.key} className="card overflow-hidden">
              {/* Song header — click anywhere to collapse/expand. */}
              <div
                className={`px-5 py-3 flex items-center gap-2.5 cursor-pointer hover:bg-gray-50/60 ${songCollapsed ? '' : 'border-b border-divider'}`}
                onClick={() => toggleSongCollapse(songKey)}
                title={songCollapsed ? 'Expand this song' : 'Collapse this song'}
              >
                {songCollapsed
                  ? <ChevronRight size={13} className="text-gray-400 shrink-0" />
                  : <ChevronDown size={13} className="text-gray-400 shrink-0" />}
                {/* Section select-all — checks/unchecks every item in this
                    song (or label bucket) regardless of collapse state. */}
                {(() => {
                  const secItems = sec.categories.flatMap(c => c.items)
                  const allSel = secItems.length > 0 && secItems.every(i => selectedIds.has(i.id))
                  return (
                    <input
                      type="checkbox"
                      checked={allSel}
                      onChange={() => selectItems(secItems)}
                      onClick={e => e.stopPropagation()}
                      title={allSel ? 'Deselect every item in this section' : 'Select every item in this section'}
                      className="h-3.5 w-3.5 rounded border-gray-300 text-boom-600 focus:ring-boom-500 cursor-pointer shrink-0"
                    />
                  )
                })()}
                {sec.isLabel
                  ? <Tag size={13} className="text-boom-500 shrink-0" />
                  : <Music2 size={13} className="text-boom-500 shrink-0" />}
                <h3 className={`text-sm font-bold truncate ${sec.key === '__nosong__' || sec.isUnlabeled ? 'text-amber-700 italic' : 'text-gray-900'}`}>
                  {sec.song}
                </h3>
                <span className="text-xs font-bold text-gray-700 tabular-nums ml-auto">
                  {sec.count} item{sec.count === 1 ? '' : 's'} · <span className="text-emerald-700 font-black">{fmtTotals(sec.totals)}</span>
                  {Object.keys(sec.totals).length > 1 && totalsToUsd(sec.totals, fxRates) != null && (
                    <span className="text-gray-500 font-semibold"> (≈ {fmtMoney(totalsToUsd(sec.totals, fxRates), 'USD')})</span>
                  )}
                </span>
              </div>
              {!songCollapsed && sec.categories.map(c => {
                const catKey = `${songKey}::${c.cat}`
                const catCollapsed = collapsedCats.has(catKey)
                return (
                <div key={c.cat}>
                  {/* Category sub-header — chevron collapses the bucket;
                      clicking the rest of the row still toggle-selects
                      everything in it for bulk labeling. Hidden for the
                      label-mode pseudo-category (the section IS the bucket). */}
                  {c.cat !== '__ALL__' && (
                  <div
                    className="flex items-center justify-between pl-8 pr-5 py-1.5 bg-gray-100/60 border-b border-gray-200 cursor-pointer hover:bg-gray-100"
                    onClick={() => selectItems(c.items)}
                    title="Click to select / deselect every item in this category"
                  >
                    <span className="text-[11px] font-semibold text-gray-600 inline-flex items-center gap-1.5">
                      <button
                        onClick={e => { e.stopPropagation(); toggleCatCollapse(catKey) }}
                        className="text-gray-400 hover:text-gray-700 -ml-1 p-0.5"
                        title={catCollapsed ? 'Expand this category' : 'Collapse this category'}
                      >
                        {catCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                      </button>
                      {/* Visible select-all for the bucket — same action the
                          row-click performs, made discoverable. */}
                      <input
                        type="checkbox"
                        checked={c.items.length > 0 && c.items.every(i => selectedIds.has(i.id))}
                        onChange={() => selectItems(c.items)}
                        onClick={e => e.stopPropagation()}
                        title="Select / deselect every item in this category"
                        className="h-3 w-3 rounded border-gray-300 text-boom-600 focus:ring-boom-500 cursor-pointer"
                      />
                      <FolderOpen size={11} className="text-gray-400" /> {c.cat}
                      {catCollapsed && <span className="text-gray-400 font-normal">({c.items.length})</span>}
                    </span>
                    <span className="text-[10px] text-gray-500 tabular-nums">{fmtTotals(c.totals)}</span>
                  </div>
                  )}
                  {!catCollapsed && c.items.map(it => {
                    const isSel = selectedIds.has(it.id)
                    const label = plan[it.id] ?? ''
                    return (
                      <div
                        key={it.id}
                        id={`plan-item-${it.id}`}
                        className={`flex items-center gap-3 pl-8 pr-5 py-2.5 border-b border-gray-50 cursor-pointer transition-colors ${
                          focusId === it.id
                            ? 'bg-amber-50 ring-2 ring-inset ring-amber-300'
                            : isSel ? 'bg-boom-50/40 hover:bg-boom-50' : 'hover:bg-gray-50/60'
                        }`}
                        onClick={() => toggleSelect(it.id)}
                      >
                        <input
                          type="checkbox"
                          checked={isSel}
                          onChange={() => toggleSelect(it.id)}
                          onClick={e => e.stopPropagation()}
                          className="h-4 w-4 rounded border-gray-300 text-boom-600 focus:ring-boom-500 cursor-pointer flex-shrink-0"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-2 flex-wrap">
                            <p className="text-sm font-semibold text-gray-900 truncate max-w-[260px]">
                              {it.payee || '—'}
                            </p>
                            {label !== '' && (
                              <button
                                onClick={e => openLabelMenu(e, it.id, label)}
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-boom-50 text-boom-700 ring-1 ring-boom-200/60 hover:bg-boom-100"
                                title="Click to change or clear this label"
                              >
                                <Tag size={9} /> {label}
                              </button>
                            )}
                          </div>
                          <p className="text-[11px] text-gray-500 flex items-center gap-1.5 flex-wrap mt-0.5">
                            {/* Unpaid items can be planned ahead of payment,
                                so the pill genuinely varies — green Paid /
                                red Unpaid. */}
                            <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold ${
                              it.payment_status === 'Paid' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'
                            }`}>
                              {it.payment_status || 'Unpaid'}
                            </span>
                            <span className="tabular-nums">
                              {it.payment_date ? `paid ${formatDate(it.payment_date)}` : (it.invoice_date ? formatDate(it.invoice_date) : '—')}
                            </span>
                            {it.invoice_number && <span className="text-gray-400">· #{it.invoice_number}</span>}
                            {/* Label mode loses the song sections, so the
                                song rides along on each row instead. */}
                            {groupMode === 'label' && (
                              <span className="inline-flex items-center gap-1 text-gray-500">
                                <Music2 size={9} className="text-gray-400" /> {(it.song || '').trim() || '(no song)'}
                                {it.category && <span className="text-gray-400">· {it.category}</span>}
                              </span>
                            )}
                            {/* Cobrand toggle — clickable chip when set,
                                muted 'Add cobrand' placeholder when not.
                                Mirrors the Recoupments page pattern. */}
                            {it.cobrand ? (
                              <button
                                onClick={e => { e.stopPropagation(); toggleCobrand(it.id, it.cobrand) }}
                                disabled={savingId === it.id}
                                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-semibold bg-gray-100 ring-1 ring-blue-200/60 text-blue-700 hover:bg-gray-200 transition-colors ${savingId === it.id ? 'opacity-50' : ''}`}
                                title="Cobrand expense — click to remove"
                              >
                                <Sparkles size={9} className="text-blue-500" />
                                Cobrand
                              </button>
                            ) : (
                              <button
                                onClick={e => { e.stopPropagation(); toggleCobrand(it.id, it.cobrand) }}
                                disabled={savingId === it.id}
                                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium text-gray-400 hover:text-blue-700 hover:bg-blue-50 hover:ring-1 hover:ring-blue-200/60 transition-colors ${savingId === it.id ? 'opacity-50' : ''}`}
                                title="Mark this expense as cobrand"
                              >
                                <Sparkles size={9} />
                                Add cobrand
                              </button>
                            )}
                            {/* Add label — the per-item companion to the
                                bulk bar's "Move to label". Only shown when
                                unlabeled; labeled rows edit via their chip. */}
                            {label === '' && (
                              <button
                                onClick={e => openLabelMenu(e, it.id, '')}
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium text-gray-400 hover:text-boom-700 hover:bg-boom-50 hover:ring-1 hover:ring-boom-200/60 transition-colors"
                                title="Label this item (labels are stamped as recoupment_label on Done)"
                              >
                                <Tag size={9} />
                                Add label
                              </button>
                            )}
                            {(() => {
                              const handles = rowSocials(it)
                              return handles.length > 0 && (
                                <span
                                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-gray-100 text-sky-700 ring-1 ring-sky-200/60 truncate max-w-[180px]"
                                  title={handles.map(h => h.display).join('\n')}
                                >
                                  <AtSign size={9} />
                                  <span className="truncate">{handles[0].display}</span>
                                  {handles.length > 1 && <span className="text-sky-500 font-bold">+{handles.length - 1}</span>}
                                </span>
                              )
                            })()}
                          </p>
                          {/* Flag note — readable inline, no popover needed.
                              The FlagButton stays the edit/clear affordance. */}
                          {it.flagged && (
                            <p className="mt-1 w-fit flex items-start gap-1.5 max-w-full rounded px-2 py-1 text-[11px] text-amber-800 bg-amber-50 ring-1 ring-amber-200/60">
                              <Flag size={10} className="mt-0.5 shrink-0 fill-amber-500 text-amber-700" />
                              <span className="whitespace-pre-wrap break-words">
                                {it.flag_reason || 'Flagged for review'}
                                {it.flagged_by_name && <span className="text-amber-600 font-semibold"> — {it.flagged_by_name}</span>}
                              </span>
                            </p>
                          )}
                          {/* Comment strips — same inline treatment as the
                              flag note, sky-tinted. The 💬 button remains
                              the composer/delete affordance. */}
                          {(commentsByEntry[it.id] || []).map(c => (
                            <p key={c.id} className="mt-1 w-fit flex items-start gap-1.5 max-w-full rounded px-2 py-1 text-[11px] text-sky-800 bg-sky-50 ring-1 ring-sky-200/60">
                              <MessageSquare size={10} className="mt-0.5 shrink-0 text-sky-600" />
                              <span className="whitespace-pre-wrap break-words">
                                {c.comment}
                                <span className="text-sky-600 font-semibold"> — {c.user_name}</span>
                              </span>
                            </p>
                          ))}
                        </div>
                        {/* View invoice — same FilePreview overlay + parent
                            fallback the Recoupments page uses. */}
                        {hasInvoiceFile(it) ? (
                          <button
                            onClick={e => {
                              e.stopPropagation()
                              setPreviewFile({ url: invoiceUrl(it), filename: `Invoice-${it.payee || it.id}` })
                            }}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-bold bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors shrink-0"
                            title="View invoice"
                          >
                            <FileText size={12} /> Invoice
                          </button>
                        ) : (
                          <span
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-gray-300 cursor-default shrink-0"
                            title="No invoice on file"
                          >
                            <FileText size={12} /> —
                          </span>
                        )}
                        {/* Recoupable toggle */}
                        <button
                          onClick={e => { e.stopPropagation(); toggleRecoupable(it.id, it.recoupable) }}
                          disabled={savingId === it.id}
                          className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-bold transition-all ${
                            it.recoupable
                              ? 'bg-boom-100 text-boom-700 hover:bg-boom-200'
                              : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                          } ${savingId === it.id ? 'opacity-50' : ''}`}
                          title={it.recoupable ? 'Mark as not recoupable — un-recouping removes it from the plan' : 'Mark as recoupable'}
                        >
                          {it.recoupable && <Check size={11} />}
                          Recoup
                        </button>
                        {/* UFR toggle — plan items are always pending, so this
                            renders the dashed 'UFR' state; clicking it stamps
                            the row UFR now (what Done does in bulk) and the
                            eligibility filter drops it from the plan. */}
                        <button
                          onClick={e => { e.stopPropagation(); toggleUfr(it.id, it.ufr) }}
                          disabled={savingId === it.id}
                          className={`inline-flex items-center gap-1 rounded-md text-xs font-bold transition-all ${
                            it.ufr === 'Yes'
                              ? 'bg-emerald-500 text-white px-3 py-1 shadow-sm hover:bg-emerald-600 ring-1 ring-emerald-600/20'
                              : 'bg-card text-gray-500 px-2.5 py-1 border border-dashed border-gray-300 hover:border-emerald-400 hover:text-emerald-600 hover:bg-emerald-50/40'
                          } ${savingId === it.id ? 'opacity-50' : ''}`}
                          title={it.ufr === 'Yes' ? 'Uploaded for recoupment — click to undo' : "Mark as uploaded for recoupment — this removes it from the plan (that's what Done does in bulk)"}
                        >
                          {it.ufr === 'Yes' ? <CheckCircle2 size={13} strokeWidth={2.5} /> : null}
                          {it.ufr === 'Yes' ? 'Uploaded' : 'UFR'}
                        </button>
                        {/* Split — divides this expense across multiple
                            artists. Hidden on split children (parent_id
                            set) since you split parents, not children. */}
                        {!it.parent_id && (
                          <button
                            onClick={e => { e.stopPropagation(); openSplitModal(it) }}
                            title="Split this invoice across multiple artists"
                            className="text-xs font-semibold px-2 py-1 rounded-md text-boom-700 bg-boom-50 hover:bg-boom-100 border border-boom-200 inline-flex items-center gap-1"
                          >
                            <Copy size={11} /> Split
                          </button>
                        )}
                        <span className="text-base font-black text-boom-600 tabular-nums whitespace-nowrap">
                          {fmtMoney(it.amount, it.currency || 'USD')}
                        </span>
                        <FlagButton
                          flagged={!!it.flagged}
                          reason={it.flag_reason || ''}
                          flaggedBy={it.flagged_by_name || ''}
                          flaggedAt={it.flagged_at}
                          onToggle={(next, reason) => toggleExpenseFlag(it.id, next, reason ?? null)}
                          onSaveReason={(reason) => saveExpenseFlagReason(it.id, reason)}
                          size="sm"
                          alwaysVisible
                        />
                        <CommentThreadButton
                          entryId={it.id}
                          initialCount={Number(it.comment_count) || 0}
                          placeholder={'e.g. "Recoupable against the Gimme Love release"'}
                          onThreadChange={onThreadChange}
                        />
                        {/* Delete (soft) — server cascades to split-family
                            children; the row leaves entries AND the plan. */}
                        <button
                          onClick={e => { e.stopPropagation(); handleDeleteEntry(it) }}
                          disabled={deletingId === it.id}
                          className={`p-1.5 rounded-md text-gray-300 hover:bg-red-50 hover:text-red-600 transition-colors ${deletingId === it.id ? 'opacity-50' : ''}`}
                          title="Delete this expense (soft-delete — recover from the Ledger)"
                        >
                          {deletingId === it.id ? <Loader size={13} className="animate-spin" /> : <Trash2 size={13} />}
                        </button>
                        <button
                          onClick={e => { e.stopPropagation(); removeItem(it.id) }}
                          className="text-gray-300 hover:text-rose-600 p-1"
                          title="Remove from plan (keeps the expense)"
                        >
                          <X size={13} />
                        </button>
                      </div>
                    )
                  })}
                </div>
                )
              })}
            </div>
            )
          })}
        </div>
      )}

      {/* Split-across-artists modal. Ported from the Recoupments page —
          the split server-side reshapes the family, so Save refetches. */}
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
                    {splitModal.row.payee || '—'} · {fmtMoney(total, cur)} {cur !== 'USD' && (
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
                        className="col-span-4 px-3 py-2 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400" />
                      <input type="text" value={r.song}
                        onChange={e => updateSplitRow(i, 'song', e.target.value)}
                        placeholder="(optional)"
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

                <div className="mt-3 flex items-center justify-between">
                  <button onClick={addSplitRow}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold text-boom-700 bg-boom-50 hover:bg-boom-100 border border-boom-200">
                    <Plus size={12} /> Add row
                  </button>
                  <div className="text-xs text-gray-600">
                    Allocated <span className="font-bold text-gray-900">{fmtMoney(allocated, cur)}</span>
                    {' · '}
                    Remaining{' '}
                    <span className={`font-bold ${remainingClose ? 'text-emerald-700' : 'text-red-600'}`}>
                      {fmtMoney(remaining, cur)}
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

      {previewFile && (
        <FilePreview url={previewFile.url} filename={previewFile.filename} onClose={() => setPreviewFile(null)} />
      )}

      {/* ── Per-item label menu ─────────────────────────────────────────── */}
      {labelMenu && createPortal(
        <>
          <div className="fixed inset-0 z-50" onClick={() => setLabelMenu(null)} />
          <div
            style={{ position: 'fixed', top: labelMenu.top, left: labelMenu.left, zIndex: 60, width: 240 }}
            className="bg-card border border-rule rounded-lg shadow-lg py-1 text-xs max-h-72 overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            {visibleLabels.map(l => (
              <button
                key={l}
                onClick={() => applyLabel(l)}
                className={`w-full px-3 py-1.5 text-left hover:bg-gray-50 truncate inline-flex items-center gap-1.5 ${l === labelMenu.current ? 'font-bold text-boom-700' : 'text-gray-700'}`}
              >
                <Tag size={10} className="shrink-0 text-boom-500" /> {l}{l === labelMenu.current ? ' ✓' : ''}
              </button>
            ))}
            {visibleLabels.length > 0 && <div className="border-t border-divider my-1" />}
            <div className="px-2 py-1.5 flex items-center gap-1.5">
              <input
                value={labelDraft}
                onChange={e => setLabelDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && labelDraft.trim()) applyLabel(labelDraft) }}
                placeholder="New label…"
                className="flex-1 min-w-0 rounded border border-rule px-2 py-1 text-xs bg-card focus:outline-none focus:ring-1 focus:ring-boom-400"
                autoFocus
              />
              <button
                onClick={() => applyLabel(labelDraft)}
                disabled={!labelDraft.trim()}
                className="btn-primary text-xs disabled:opacity-40"
              >
                Add
              </button>
            </div>
            {labelMenu.current && (
              <button
                onClick={() => applyLabel('')}
                className="w-full px-3 py-1.5 text-left text-rose-600 hover:bg-rose-50 font-semibold"
              >
                Clear label
              </button>
            )}
          </div>
        </>,
        document.body
      )}
    </div>
  )
}
