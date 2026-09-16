import { useState, useEffect, useCallback, useRef } from 'react'
import { Loader, AlertCircle, ChevronDown, ChevronRight, Trash2, ExternalLink, Plus, CheckCircle2, Circle, Users, X, Archive, RotateCcw, AtSign } from 'lucide-react'
import api from '../api'
import Skeleton from '../components/Skeleton'
import { SOCIAL_PLATFORMS } from '../constants'

// Same centered modal the Artist Campaigns / socials editors use —
// token classes (bg-card / border-rule / bg-overlay) so both themes work.
function Modal({ onClose, title, children }) {
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
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

// Parse the JSONB social_handles column into displayable rows — same
// normalization the Artist Campaigns page uses.
function socialsList(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .map(s => {
      const platform = (s?.platform || '').trim()
      const handle = (s?.handle || '').trim()
      if (!handle) return null
      return { platform, handle, artist: (s?.artist || '').trim(), amount: s?.amount, display: (platform ? `${platform} ${handle}` : handle) + (s?.amount ? ` · $${s.amount}` : '') }
    })
    .filter(Boolean)
}
const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', GBP: '£', CAD: 'CA$', AUD: 'A$', MXN: 'MX$', JPY: '¥', BRL: 'R$', CHF: 'Fr ' }

function fmt(v, currency = 'USD') {
  if (!v && v !== 0) return '—'
  const num = Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const code = (currency || 'USD').toUpperCase()
  const sym = CURRENCY_SYMBOLS[code]
  return sym ? sym + num : code + '\u00a0' + num
}

function fmtDate(d) {
  if (!d) return '—'
  const s = String(d).slice(0, 10).split('-')
  return s.length === 3 ? `${s[1]}/${s[2]}/${s[0].slice(2)}` : '—'
}

export default function BkBulkDeals() {
  const [deals, setDeals] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expandedId, setExpandedId] = useState(null)
  const [items, setItems] = useState({}) // { expenseId: [...items] }
  const [loadingItems, setLoadingItems] = useState(null)
  const [newTitle, setNewTitle] = useState({})
  // Deal ids with an add-deliverable POST in flight (double-submit guard).
  const addBusyRef = useRef(new Set())
  const [toast, setToast] = useState('')
  const [splits, setSplits] = useState({})        // { dealId: [{artist,song,amount}] }
  const [splitsDirty, setSplitsDirty] = useState({}) // { dealId: true }
  const [savingSplit, setSavingSplit] = useState(null)
  const [showCompleted, setShowCompleted] = useState(false)

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 3000) }

  // Initialize splits when expanding a deal
  const initSplits = useCallback((deal) => {
    if (splits[deal.id]) return // already loaded
    if (deal.artist_breakdown && Array.isArray(deal.artist_breakdown) && deal.artist_breakdown.length >= 2) {
      setSplits(prev => ({ ...prev, [deal.id]: deal.artist_breakdown.map(s => ({ artist: s.artist || '', song: s.song || '', amount: s.amount || 0 })) }))
    }
    // else: no splits yet — user can add via button
  }, [splits])

  const addSplitRow = (dealId, deal) => {
    setSplits(prev => {
      const current = prev[dealId]
      if (!current) {
        // First time enabling splits — initialize with current artist + empty row
        return { ...prev, [dealId]: [
          { artist: deal.artist || '', song: deal.song || '', amount: Number(deal.amount) || 0 },
          { artist: '', song: '', amount: 0 },
        ]}
      }
      return { ...prev, [dealId]: [...current, { artist: '', song: '', amount: 0 }] }
    })
    setSplitsDirty(prev => ({ ...prev, [dealId]: true }))
  }

  const updateSplitRow = (dealId, idx, field, value) => {
    setSplits(prev => ({
      ...prev,
      [dealId]: prev[dealId].map((r, i) => i === idx ? { ...r, [field]: field === 'amount' ? (Number(value) || 0) : value } : r)
    }))
    setSplitsDirty(prev => ({ ...prev, [dealId]: true }))
  }

  const removeSplitRow = (dealId, idx) => {
    setSplits(prev => {
      const next = prev[dealId].filter((_, i) => i !== idx)
      if (next.length < 2) {
        // Can't have 1 split — remove splits entirely
        const copy = { ...prev }
        delete copy[dealId]
        return copy
      }
      return { ...prev, [dealId]: next }
    })
    setSplitsDirty(prev => ({ ...prev, [dealId]: true }))
  }

  const saveSplits = async (dealId) => {
    const rows = splits[dealId]
    if (!rows || rows.length < 2) return
    const valid = rows.filter(r => r.artist.trim() && r.amount > 0)
    if (valid.length < 2) { showToast('Need at least 2 artists with amounts'); return }
    setSavingSplit(dealId)
    try {
      await api.post(`/bk/entries/${dealId}/split`, { artist_breakdown: valid })
      // Update local deal data to reflect the split
      setDeals(prev => prev.map(d => {
        if (d.id !== dealId) return d
        const combinedTotal = valid.reduce((s, v) => s + (Number(v.amount) || 0), 0)
        return { ...d, artist: valid[0].artist, song: valid[0].song || d.song, amount: valid[0].amount, combined_amount: combinedTotal, artist_breakdown: valid, split_count: valid.length - 1 }
      }))
      setSplits(prev => ({ ...prev, [dealId]: valid }))
      setSplitsDirty(prev => ({ ...prev, [dealId]: false }))
      showToast(`Split between ${valid.length} artists`)
    } catch (err) { showToast('Failed to save splits: ' + (err.response?.data?.error || err.message)) }
    finally { setSavingSplit(null) }
  }

  const removeSplits = async (dealId) => {
    setSavingSplit(dealId)
    try {
      await api.delete(`/bk/entries/${dealId}/splits`)
      // Restore deal to combined amount
      const deal = deals.find(d => d.id === dealId)
      const totalAmount = Number(deal?.combined_amount || deal?.amount) || 0
      setDeals(prev => prev.map(d => d.id !== dealId ? d : { ...d, amount: totalAmount, combined_amount: totalAmount, artist_breakdown: null, split_count: 0 }))
      setSplits(prev => { const copy = { ...prev }; delete copy[dealId]; return copy })
      setSplitsDirty(prev => ({ ...prev, [dealId]: false }))
      showToast('Splits removed')
    } catch (err) { showToast('Failed to remove splits') }
    finally { setSavingSplit(null) }
  }

  const saveDealField = async (dealId, field, value) => {
    try {
      await api.put(`/bk/entries/${dealId}`, { [field]: value })
      setDeals(prev => prev.map(d => d.id === dealId ? { ...d, [field]: value } : d))
    } catch (err) { showToast('Failed to save') }
  }

  useEffect(() => {
    api.get('/bk/bulk-deals')
      .then(r => setDeals(r.data.data || []))
      .catch(err => setError(err.response?.data?.error || err.message))
      .finally(() => setLoading(false))
  }, [])

  const toggleExpand = async (dealId) => {
    if (expandedId === dealId) { setExpandedId(null); return }
    setExpandedId(dealId)
    const deal = deals.find(d => d.id === dealId)
    if (deal) initSplits(deal)
    if (!items[dealId]) {
      setLoadingItems(dealId)
      try {
        const r = await api.get(`/bk/bulk-deals/${dealId}/items`)
        setItems(prev => ({ ...prev, [dealId]: r.data.data || [] }))
      } catch (err) { setError(err.response?.data?.error || err.message) }
      finally { setLoadingItems(null) }
    }
  }

  const addItemWithTitle = async (dealId, title) => {
    if (!title) return
    // In-flight guard — Enter key-repeat (or a fast double press) fired N
    // POSTs of the same title before the first resolved, creating
    // duplicate deliverables.
    if (addBusyRef.current.has(dealId)) return
    addBusyRef.current.add(dealId)
    try {
      const r = await api.post(`/bk/bulk-deals/${dealId}/items`, { title })
      setItems(prev => ({ ...prev, [dealId]: [...(prev[dealId] || []), r.data.data] }))
      setDeals(prev => prev.map(d => d.id === dealId ? { ...d, total_items: d.total_items + 1 } : d))
    } catch (err) { showToast('Failed to add item') }
    finally { addBusyRef.current.delete(dealId) }
  }
  const addItem = async (dealId) => {
    const title = (newTitle[dealId] || '').trim()
    if (!title) return
    await addItemWithTitle(dealId, title)
    setNewTitle(prev => ({ ...prev, [dealId]: '' }))
  }

  const toggleComplete = async (dealId, item) => {
    const newVal = !item.completed
    try {
      await api.put(`/bk/bulk-deals/items/${item.id}`, { completed: newVal })
      setItems(prev => ({
        ...prev,
        [dealId]: prev[dealId].map(i => i.id === item.id ? { ...i, completed: newVal, completed_at: newVal ? new Date().toISOString() : null } : i)
      }))
      setDeals(prev => prev.map(d => d.id === dealId ? { ...d, completed_items: d.completed_items + (newVal ? 1 : -1) } : d))
    } catch (err) { showToast('Failed to update') }
  }

  const updateItemField = async (dealId, itemId, field, value) => {
    try {
      await api.put(`/bk/bulk-deals/items/${itemId}`, { [field]: value })
      setItems(prev => ({
        ...prev,
        [dealId]: prev[dealId].map(i => i.id === itemId ? { ...i, [field]: value } : i)
      }))
    } catch (err) { showToast('Failed to save') }
  }

  const deleteItem = async (dealId, itemId) => {
    try {
      await api.delete(`/bk/bulk-deals/items/${itemId}`)
      const wasCompleted = items[dealId]?.find(i => i.id === itemId)?.completed
      setItems(prev => ({ ...prev, [dealId]: prev[dealId].filter(i => i.id !== itemId) }))
      setDeals(prev => prev.map(d => d.id === dealId ? {
        ...d,
        total_items: d.total_items - 1,
        completed_items: d.completed_items - (wasCompleted ? 1 : 0),
      } : d))
    } catch (err) { showToast('Failed to delete') }
  }

  const archiveDeal = async (dealId) => {
    try {
      await api.put(`/bk/entries/${dealId}`, { bulk_deal_completed: true })
      setDeals(prev => prev.map(d => d.id === dealId ? { ...d, bulk_deal_completed: true } : d))
      showToast('Deal moved to completed')
    } catch { showToast('Failed to archive') }
  }

  const restoreDeal = async (dealId) => {
    try {
      await api.put(`/bk/entries/${dealId}`, { bulk_deal_completed: false })
      setDeals(prev => prev.map(d => d.id === dealId ? { ...d, bulk_deal_completed: false } : d))
      showToast('Deal restored')
    } catch { showToast('Failed to restore') }
  }

  // ── Socials editor ────────────────────────────────────────────────────────
  // Same platform / handle / For-artist editor the Artist Campaigns and
  // Recoupments pages use — saves to the deal expense's JSONB
  // social_handles via PUT /bk/entries/:id, so the handles surface on
  // every reconciliation view, not just here.
  const [socialsModal, setSocialsModal] = useState(null) // { dealId, payee, familyArtists }
  const [socialsRows, setSocialsRows] = useState([])
  const [socialsSaving, setSocialsSaving] = useState(false)
  const openSocialsEditor = (deal) => {
    const existing = socialsList(deal.social_handles)
    setSocialsRows(existing.length
      ? existing.map(s => ({ platform: s.platform || 'Instagram', handle: s.handle, artist: s.artist || '', amount: s?.amount ?? '' }))
      : [{ platform: 'Instagram', handle: '', artist: '', amount: '' }])
    const familyArtists = [...new Set((Array.isArray(deal.artist_breakdown) ? deal.artist_breakdown : [])
      .map(b => (b?.artist || '').trim()).filter(Boolean))]
    setSocialsModal({ dealId: deal.id, payee: deal.payee, familyArtists })
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
    try {
      await api.put(`/bk/entries/${socialsModal.dealId}`, { social_handles: cleaned })
      setDeals(prev => prev.map(d => d.id === socialsModal.dealId ? { ...d, social_handles: cleaned } : d))
      setSocialsModal(null)
      showToast('Socials updated')
    } catch { showToast('Failed to save socials') }
    finally { setSocialsSaving(false) }
  }

  // Contracted deliverables — the quantity agreed at intake wins over
  // however many items happen to be logged, so progress reads against
  // the deal, not against the checklist's current length.
  const contractedOf = (d) => Math.max(Number(d.bulk_deal_quantity) || 0, Number(d.total_items) || 0)
  // Paid-vs-delivered: installment rows (expense_payments) are the precise
  // signal when the deal pays in tranches; otherwise fall back to the
  // family rows' payment_status sum the endpoint provides.
  const paidOf = (d) => {
    const total = Number(d.combined_amount || d.amount) || 0
    const raw = Number(d.installment_count) > 0 ? Number(d.installments_paid) : Number(d.status_paid_total)
    const paid = Math.min(raw || 0, total)
    return { total, paid, pct: total > 0 ? Math.round((paid / total) * 100) : 0 }
  }
  const singularUnit = (u) => {
    const s = String(u || 'item').trim() || 'item'
    return s.endsWith('s') ? s.slice(0, -1) : s
  }
  // Stalled: money out, still under-delivered, and nothing delivered in
  // 30+ days (grace window from invoice_date when nothing was ever
  // delivered). Mirrors the smart-alert rule in /api/notifications.
  const STALL_DAYS = 30
  const stalledInfo = (d) => {
    if (d.bulk_deal_completed) return { stalled: false }
    const pay = paidOf(d)
    if (!(pay.paid > 0)) return { stalled: false }
    const contracted = contractedOf(d)
    if (contracted > 0 && d.completed_items >= contracted) return { stalled: false }
    const anchor = d.last_delivery_at || d.invoice_date
    if (!anchor) return { stalled: false }
    const days = Math.floor((Date.now() - new Date(anchor).getTime()) / 86400000)
    return { stalled: days >= STALL_DAYS, days }
  }

  const activeDealsRaw = deals.filter(d => !d.bulk_deal_completed)
  // Stalled deals float to the top — they're the reason to open this
  // page. Stable sort keeps the endpoint's date order within each group.
  const activeDeals = [...activeDealsRaw].sort((a, b) =>
    (stalledInfo(b).stalled ? 1 : 0) - (stalledInfo(a).stalled ? 1 : 0)
  )
  const completedDeals = deals.filter(d => d.bulk_deal_completed)
  const totalDeliverables = activeDeals.reduce((s, d) => s + contractedOf(d), 0)
  const totalCompleted = activeDeals.reduce((s, d) => s + d.completed_items, 0)
  // Header rollups — per currency so multi-currency deals stay honest.
  const committedByCur = activeDeals.reduce((acc, d) => {
    const c = (d.currency || 'USD').toUpperCase()
    acc[c] = (acc[c] || 0) + (Number(d.combined_amount || d.amount) || 0)
    return acc
  }, {})
  const unitEcon = activeDeals.reduce((acc, d) => {
    const n = contractedOf(d)
    if (!n) return acc
    const c = (d.currency || 'USD').toUpperCase()
    if (!acc[c]) acc[c] = { amt: 0, units: 0 }
    acc[c].amt += Number(d.combined_amount || d.amount) || 0
    acc[c].units += n
    return acc
  }, {})
  const committedStr = Object.entries(committedByCur).map(([c, v]) => fmt(v, c)).join(' + ')
  const avgStr = Object.entries(unitEcon)
    .map(([c, { amt, units }]) => `${fmt(amt / units, c)}/deliverable`)
    .join(' + ')

  if (loading) return (
    <div className="space-y-6">
      <Skeleton.PageHeader />
      <Skeleton.StatCards count={3} />
      <div className="space-y-3">
        <Skeleton.Card />
        <Skeleton.Card />
        <Skeleton.Card />
      </div>
    </div>
  )

  return (
    <div className="max-w-[960px] mx-auto px-4">
      <div className="mb-6">
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900 tracking-tight">Bulk Deals</h1>
        <p className="text-sm text-gray-400 mt-1">
          {activeDeals.length} active deal{activeDeals.length !== 1 ? 's' : ''} &middot; {totalCompleted}/{totalDeliverables} contracted deliverables received
          {committedStr && ` \u00b7 ${committedStr} committed`}
          {avgStr && ` \u00b7 avg ${avgStr}`}
          {completedDeals.length > 0 && ` \u00b7 ${completedDeals.length} completed`}
        </p>
      </div>

      {error && (
        <div className="flex items-center gap-2 bg-rose-50 border border-rose-200 text-rose-700 rounded-lg px-3.5 py-2.5 text-sm mb-4">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
          <button onClick={() => setError('')} className="ml-auto text-rose-700 hover:text-rose-900">✕</button>
        </div>
      )}
      {toast && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-lg px-3.5 py-2.5 text-sm font-semibold mb-4">
          {toast}
        </div>
      )}

      {activeDeals.length === 0 && completedDeals.length === 0 ? (
        <div className="text-center px-5 py-20 bg-card rounded-2xl border border-divider">
          <p className="text-[15px] font-semibold text-gray-400">
            No bulk deals yet. Mark an invoice as a bulk deal on the Ledger to get started.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {activeDeals.map(deal => {
            const isExpanded = expandedId === deal.id
            const contracted = contractedOf(deal)
            const pct = contracted > 0 ? Math.min(100, Math.round((deal.completed_items / contracted) * 100)) : 0
            const pay = paidOf(deal)
            // Risk signal: money is meaningfully ahead of deliverables —
            // hold the next tranche until delivery catches up.
            const paidAhead = pay.pct - pct >= 25 && pct < 100
            const stall = stalledInfo(deal)
            const dealItems = items[deal.id] || []

            return (
              <div key={deal.id} className="bg-card border border-divider rounded-2xl overflow-hidden">
                {/* Deal header */}
                <div
                  onClick={() => toggleExpand(deal.id)}
                  className="px-5 py-4 cursor-pointer flex items-center gap-3 hover:bg-gray-50/60 transition-colors"
                >
                  {isExpanded
                    ? <ChevronDown className="w-4 h-4 text-gray-400 shrink-0" />
                    : <ChevronRight className="w-4 h-4 text-gray-400 shrink-0" />
                  }
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2.5 flex-wrap">
                      <span className="font-bold text-gray-900 text-sm">{deal.payee}</span>
                      {deal.artist && <span className="text-xs text-gray-500">{deal.artist}</span>}
                      {deal.artist_breakdown && deal.artist_breakdown.length >= 2 && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold text-blue-700 bg-blue-50 ring-1 ring-blue-200/60">
                          {deal.artist_breakdown.length} artists
                        </span>
                      )}
                      {deal.category && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide text-gray-600 bg-gray-100 ring-1 ring-gray-200/60">
                          {deal.category}
                        </span>
                      )}
                      {/* Socials chip — same visual language as the Artist
                          Campaigns rows: sky chip when handles exist, amber
                          "Add socials" call-to-action when missing. */}
                      {(() => {
                        const handles = socialsList(deal.social_handles)
                        return handles.length ? (
                          <button
                            onClick={e => { e.stopPropagation(); openSocialsEditor(deal) }}
                            title={handles.map(h => h.display).join('\n')}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold ring-1 truncate max-w-[180px] bg-slate-100 ring-sky-200/60 text-sky-700 hover:bg-slate-200"
                          >
                            <AtSign size={9} />
                            <span className="truncate">{handles[0].display}</span>
                            {handles.length > 1 && <span className="text-sky-500 font-bold">+{handles.length - 1}</span>}
                          </button>
                        ) : (
                          <button
                            onClick={e => { e.stopPropagation(); openSocialsEditor(deal) }}
                            title="Add the creators' social handles for this deal"
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold text-amber-700 bg-amber-50 ring-1 ring-amber-200/60 hover:bg-amber-100"
                          >
                            <Plus size={9} /> Add socials
                          </button>
                        )
                      })()}
                      {stall.stalled && (
                        <span
                          className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide text-rose-700 bg-rose-50 ring-1 ring-rose-200/60"
                          title={`Paid ${pay.pct}% but nothing delivered in ${stall.days} days — chase the vendor or pause further payments.`}
                        >
                          Stalled {stall.days}d
                        </span>
                      )}
                      {paidAhead && !stall.stalled && (
                        <span
                          className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide text-amber-700 bg-amber-50 ring-1 ring-amber-200/60"
                          title={`Paid ${pay.pct}% but only ${pct}% delivered — consider holding further tranches until deliverables catch up.`}
                        >
                          Paid ahead
                        </span>
                      )}
                    </div>
                    {deal.description && (
                      <div className="text-xs text-gray-400 mt-0.5 truncate max-w-[500px]">
                        {deal.description}
                      </div>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-black text-sm text-gray-900">
                      {fmt(deal.combined_amount || deal.amount, deal.currency)}
                    </div>
                    {contracted > 0 && (
                      <div className="text-[10px] font-bold text-teal-700 mt-px">
                        {fmt(pay.total / contracted, deal.currency)}/{singularUnit(deal.bulk_deal_unit)}
                      </div>
                    )}
                    <div className="text-[11px] text-gray-400 mt-0.5">{fmtDate(deal.invoice_date)}</div>
                  </div>
                  <div className="shrink-0 text-right min-w-[130px]">
                    <div className={`text-xs font-bold ${pct === 100 ? 'text-emerald-600' : 'text-gray-600'}`}>
                      {deal.completed_items}/{contracted || '—'} {deal.bulk_deal_unit || 'items'}
                    </div>
                    <div className="w-[110px] h-1.5 bg-gray-100 rounded overflow-hidden mt-1 ml-auto">
                      <div
                        className={`h-full rounded transition-all duration-300 ${pct === 100 ? 'bg-emerald-500' : 'bg-blue-500'}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    {/* Paid bar — the second half of the risk view. Amber
                        when money has meaningfully outrun deliverables. */}
                    <div className={`text-[10px] font-bold mt-1.5 ${paidAhead ? 'text-amber-700' : 'text-gray-500'}`}
                      title={`${fmt(pay.paid, deal.currency)} of ${fmt(pay.total, deal.currency)} paid`}>
                      Paid {pay.pct}%
                    </div>
                    <div className="w-[110px] h-1.5 bg-gray-100 rounded overflow-hidden mt-0.5 ml-auto">
                      <div
                        className={`h-full rounded transition-all duration-300 ${paidAhead ? 'bg-amber-500' : 'bg-emerald-500'}`}
                        style={{ width: `${pay.pct}%` }}
                      />
                    </div>
                  </div>
                  {pct === 100 && (
                    <button
                      onClick={e => { e.stopPropagation(); archiveDeal(deal.id) }}
                      title="Move to completed"
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold text-white bg-emerald-500 hover:bg-emerald-600 shrink-0 whitespace-nowrap"
                    >
                      <Archive className="w-3 h-3" /> Complete
                    </button>
                  )}
                </div>

                {/* Expanded items */}
                {isExpanded && (
                  <div className="border-t border-divider px-5 pt-3 pb-4">
                    {/* Deal parameters */}
                    <div className="flex items-center gap-2 mb-3.5 pb-3 border-b border-divider">
                      <span className="text-[10px] uppercase tracking-wide font-bold text-gray-500 whitespace-nowrap">Deal:</span>
                      <input
                        type="number"
                        min="1"
                        defaultValue={deal.bulk_deal_quantity || ''}
                        placeholder="#"
                        onBlur={e => {
                          const v = e.target.value ? parseInt(e.target.value) : null
                          if (v !== deal.bulk_deal_quantity) saveDealField(deal.id, 'bulk_deal_quantity', v)
                        }}
                        className="w-14 rounded-lg border border-rule px-2 py-1.5 text-xs font-bold text-center bg-card"
                      />
                      <input
                        defaultValue={deal.bulk_deal_unit || ''}
                        placeholder="videos, posts, etc."
                        onBlur={e => {
                          const v = e.target.value.trim() || null
                          if (v !== deal.bulk_deal_unit) saveDealField(deal.id, 'bulk_deal_unit', v)
                        }}
                        className="w-40 rounded-lg border border-rule px-2 py-1.5 text-xs bg-card"
                      />
                      <span className="text-[11px] text-gray-400">
                        {deal.bulk_deal_quantity
                          ? `${fmt((deal.combined_amount || deal.amount) / deal.bulk_deal_quantity, deal.currency)} per ${deal.bulk_deal_unit || 'item'}`
                          : 'Set quantity to see per-unit cost'}
                      </span>
                    </div>
                    {/* ── Socials section — same editor the header chip opens,
                        surfaced inside the expanded card so adding handles
                        doesn't require spotting the tiny chip up top. ── */}
                    <div className="flex items-center gap-2 flex-wrap mb-3.5 pb-3 border-b border-divider">
                      <span className="text-[10px] uppercase tracking-wide font-bold text-gray-500 whitespace-nowrap inline-flex items-center gap-1">
                        <AtSign size={10} /> Socials:
                      </span>
                      {socialsList(deal.social_handles).map((h, i) => (
                        <button
                          key={i}
                          onClick={e => { e.stopPropagation(); openSocialsEditor(deal) }}
                          title="Click to edit"
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold ring-1 bg-slate-100 ring-sky-200/60 text-sky-700 hover:bg-slate-200"
                        >
                          <AtSign size={9} /> {h.display}
                        </button>
                      ))}
                      <button
                        onClick={e => { e.stopPropagation(); openSocialsEditor(deal) }}
                        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold ring-1 ${
                          socialsList(deal.social_handles).length
                            ? 'text-gray-500 bg-gray-50 ring-gray-200/60 hover:bg-gray-100'
                            : 'text-amber-700 bg-amber-50 ring-amber-200/60 hover:bg-amber-100'
                        }`}
                      >
                        <Plus size={9} /> {socialsList(deal.social_handles).length ? 'Edit socials' : 'Add socials'}
                      </button>
                    </div>
                    {/* ── Artist Split section ── */}
                    {(() => {
                      const dealSplits = splits[deal.id]
                      const hasSplits = dealSplits && dealSplits.length >= 2
                      const isDirty = splitsDirty[deal.id]
                      const isSaving = savingSplit === deal.id
                      // Combined total from DB (parent + children)
                      const origTotal = Number(deal.combined_amount || deal.amount) || 0
                      const splitTotal = hasSplits ? dealSplits.reduce((s, r) => s + (Number(r.amount) || 0), 0) : 0
                      const totalsMatch = hasSplits && Math.abs(splitTotal - origTotal) < 0.01

                      return (
                        <div className="mb-3.5 pb-3 border-b border-divider">
                          <div className={`flex items-center justify-between ${hasSplits ? 'mb-2.5' : ''}`}>
                            <div className="flex items-center gap-2">
                              <Users className="w-3.5 h-3.5 text-gray-400" />
                              <span className="text-[10px] uppercase tracking-wide font-bold text-gray-500">Artist Split</span>
                              {deal.split_count > 0 && !hasSplits && (
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold text-blue-700 bg-blue-50 ring-1 ring-blue-200/60">
                                  {deal.split_count + 1} artists
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-1.5">
                              {hasSplits && isDirty && (
                                <button
                                  onClick={() => saveSplits(deal.id)}
                                  disabled={isSaving || !totalsMatch}
                                  className="btn-primary text-xs"
                                >
                                  {isSaving ? 'Saving...' : 'Save Split'}
                                </button>
                              )}
                              {hasSplits && !isDirty && deal.artist_breakdown && (
                                <button
                                  onClick={() => removeSplits(deal.id)}
                                  disabled={isSaving}
                                  className="px-2.5 py-1 rounded-lg text-[11px] font-semibold text-rose-600 border border-rose-200 hover:bg-rose-50 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                  Remove Split
                                </button>
                              )}
                              {!hasSplits && (
                                <button
                                  onClick={() => addSplitRow(deal.id, deal)}
                                  className="btn-secondary text-xs"
                                >
                                  Split between artists
                                </button>
                              )}
                            </div>
                          </div>

                          {hasSplits && (
                            <div>
                              {dealSplits.map((row, idx) => (
                                <div key={idx} className="flex items-center gap-1.5 mb-1.5">
                                  <input
                                    value={row.artist}
                                    onChange={e => updateSplitRow(deal.id, idx, 'artist', e.target.value)}
                                    placeholder="Artist"
                                    className="flex-[2] min-w-0 rounded-lg border border-rule px-2 py-1.5 text-xs bg-card"
                                  />
                                  <input
                                    value={row.song}
                                    onChange={e => updateSplitRow(deal.id, idx, 'song', e.target.value)}
                                    placeholder="Song (optional)"
                                    className="flex-[2] min-w-0 rounded-lg border border-rule px-2 py-1.5 text-xs bg-card"
                                  />
                                  <div className="relative flex-1">
                                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-gray-400 pointer-events-none">$</span>
                                    <input
                                      type="number"
                                      min="0"
                                      step="0.01"
                                      value={row.amount || ''}
                                      onChange={e => updateSplitRow(deal.id, idx, 'amount', e.target.value)}
                                      placeholder="0.00"
                                      className="w-full rounded-lg border border-rule pl-[18px] pr-2 py-1.5 text-xs font-bold bg-card"
                                    />
                                  </div>
                                  <button
                                    onClick={() => removeSplitRow(deal.id, idx)}
                                    className="text-gray-300 hover:text-rose-500 shrink-0 p-0.5"
                                    title="Remove"
                                  >
                                    <X className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              ))}
                              <div className="flex items-center justify-between mt-1.5">
                                <button
                                  onClick={() => addSplitRow(deal.id, deal)}
                                  className="text-[11px] font-semibold text-blue-600 hover:text-blue-700"
                                >
                                  + Add artist
                                </button>
                                <span className={`text-[11px] font-bold ${totalsMatch ? 'text-emerald-600' : 'text-amber-600'}`}>
                                  Split: {fmt(splitTotal, deal.currency)} of {fmt(origTotal, deal.currency)}
                                  {totalsMatch ? ' ✓' : ' — amounts don\'t match'}
                                </span>
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })()}

                    {loadingItems === deal.id ? (
                      <div className="flex justify-center py-5">
                        <Loader className="w-4 h-4 animate-spin text-gray-400" />
                      </div>
                    ) : (
                      <>
                        {dealItems.length === 0 && (
                          <p className="text-gray-400 text-[13px] text-center py-3">No deliverables yet. Add one below.</p>
                        )}
                        {dealItems.map(item => (
                          <div
                            key={item.id}
                            className="flex items-center gap-2.5 py-2 border-b border-divider"
                          >
                            <button
                              onClick={() => toggleComplete(deal.id, item)}
                              className="shrink-0"
                              title={item.completed ? 'Mark incomplete' : 'Mark complete'}
                            >
                              {item.completed
                                ? <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                                : <Circle className="w-5 h-5 text-gray-300" />
                              }
                            </button>
                            <input
                              defaultValue={item.title}
                              onBlur={e => {
                                const v = e.target.value.trim()
                                if (v && v !== item.title) updateItemField(deal.id, item.id, 'title', v)
                              }}
                              className={`flex-1 border-none outline-none bg-transparent py-1 text-[13px] font-semibold ${item.completed ? 'line-through text-gray-400' : 'text-gray-900'}`}
                            />
                            {/* Platform tag — travels with the evidence link
                                into the Artist Campaigns reconciliation view. */}
                            <select
                              value={item.platform || ''}
                              onChange={e => updateItemField(deal.id, item.id, 'platform', e.target.value || null)}
                              title="Platform this deliverable was posted on"
                              className={`w-24 rounded-lg border border-rule px-1.5 py-1 text-xs bg-card shrink-0 ${item.platform ? 'text-gray-600' : 'text-gray-400'}`}
                            >
                              <option value="">Platform…</option>
                              {SOCIAL_PLATFORMS.map(p => <option key={p} value={p}>{p}</option>)}
                            </select>
                            <input
                              defaultValue={item.video_url || ''}
                              placeholder="Paste link..."
                              onBlur={e => {
                                const v = e.target.value.trim()
                                if (v !== (item.video_url || '')) updateItemField(deal.id, item.id, 'video_url', v || null)
                              }}
                              className="w-[180px] rounded-lg border border-rule px-2 py-1 text-xs text-gray-600 bg-card"
                            />
                            {item.video_url && (
                              <a
                                href={item.video_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="shrink-0 text-blue-500"
                                title="Open link"
                              >
                                <ExternalLink className="w-3.5 h-3.5" />
                              </a>
                            )}
                            {item.completed_at && (
                              <span className="text-[10px] text-gray-400 whitespace-nowrap shrink-0">
                                {fmtDate(item.completed_at)}
                              </span>
                            )}
                            <button
                              onClick={() => deleteItem(deal.id, item.id)}
                              className="text-gray-300 hover:text-rose-500 shrink-0"
                              title="Remove"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                        {/* Ghost slots — contracted deliverables that don't
                            have a logged item yet. No DB rows until "Log"
                            is clicked, so the checklist can't fill up with
                            junk placeholders; capped so a qty-500 deal
                            doesn't render a wall. */}
                        {(() => {
                          const missing = Math.min(Math.max(0, contracted - dealItems.length), 25)
                          if (!missing) return null
                          const unitName = singularUnit(deal.bulk_deal_unit)
                          const cap = unitName.charAt(0).toUpperCase() + unitName.slice(1)
                          return Array.from({ length: missing }, (_, i) => {
                            const n = dealItems.length + i + 1
                            return (
                              <div key={`ghost-${n}`} className="flex items-center gap-2.5 py-2 border-b border-dashed border-divider">
                                <Circle className="w-5 h-5 text-gray-200 shrink-0" />
                                <span className="flex-1 text-[13px] text-gray-400 italic">
                                  {cap} {n} — contracted, not yet logged
                                </span>
                                <button
                                  onClick={() => addItemWithTitle(deal.id, `${cap} ${n}`)}
                                  className="rounded-lg border border-dashed border-rule px-2.5 py-0.5 text-[11px] font-bold text-gray-500 hover:bg-gray-50"
                                  title="Create this deliverable so it can be checked off / carry a link"
                                >
                                  Log
                                </button>
                              </div>
                            )
                          })
                        })()}
                        {/* Add item */}
                        <div className="flex items-center gap-2 mt-2.5">
                          <Plus className="w-4 h-4 text-gray-400 shrink-0" />
                          <input
                            value={newTitle[deal.id] || ''}
                            onChange={e => setNewTitle(prev => ({ ...prev, [deal.id]: e.target.value }))}
                            onKeyDown={e => { if (e.key === 'Enter') addItem(deal.id) }}
                            placeholder="Add deliverable..."
                            className="flex-1 rounded-lg border border-rule px-2.5 py-1.5 text-[13px] bg-card"
                          />
                          <button
                            onClick={() => addItem(deal.id)}
                            disabled={!(newTitle[deal.id] || '').trim()}
                            className="btn-primary text-xs whitespace-nowrap"
                          >
                            Add
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* ── Completed deals section ── */}
      {completedDeals.length > 0 && (
        <div className="mt-6">
          <button
            onClick={() => setShowCompleted(v => !v)}
            className="flex items-center gap-2 py-2 w-full text-left"
          >
            {showCompleted
              ? <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
              : <ChevronRight className="w-3.5 h-3.5 text-gray-400" />
            }
            <span className="text-sm font-bold text-gray-400">
              Completed ({completedDeals.length})
            </span>
          </button>
          {showCompleted && (
            <div className="flex flex-col gap-2 mt-2">
              {completedDeals.map(deal => (
                <div key={deal.id} className="bg-card rounded-xl border border-divider px-4 py-3 flex items-center gap-3 opacity-70">
                  <CheckCircle2 className="w-[18px] h-[18px] text-emerald-600 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-[13px] text-gray-900">{deal.payee}</span>
                      {deal.artist && <span className="text-xs text-gray-500">{deal.artist}</span>}
                      {deal.category && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide text-gray-600 bg-gray-100 ring-1 ring-gray-200/60">
                          {deal.category}
                        </span>
                      )}
                    </div>
                    {deal.description && (
                      <div className="text-[11px] text-gray-400 mt-0.5 truncate max-w-[400px]">{deal.description}</div>
                    )}
                  </div>
                  {deal.completed_items > 0 && (
                    <span
                      className="text-[11px] font-bold text-teal-700 shrink-0"
                      title="Effective rate — deal total ÷ deliverables actually received"
                    >
                      {fmt((Number(deal.combined_amount || deal.amount) || 0) / deal.completed_items, deal.currency)}/{singularUnit(deal.bulk_deal_unit)} effective
                    </span>
                  )}
                  <span className="text-[13px] font-black text-gray-900 shrink-0">
                    {fmt(deal.combined_amount || deal.amount, deal.currency)}
                  </span>
                  <span className="text-[11px] text-gray-400 shrink-0">{fmtDate(deal.invoice_date)}</span>
                  <button
                    onClick={() => restoreDeal(deal.id)}
                    title="Move back to active"
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold text-gray-500 border border-rule hover:bg-gray-50 shrink-0"
                  >
                    <RotateCcw className="w-[11px] h-[11px]" /> Restore
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Socials editor (centered modal) — mirrors Artist Campaigns ── */}
      {socialsModal && (
        <Modal onClose={() => !socialsSaving && setSocialsModal(null)} title={`Edit socials — ${socialsModal.payee || 'deal'}`}>
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
                {/* Per-row artist tag — only on deals split across 2+
                    artists. Empty = shared across every artist on the deal. */}
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
              onClick={() => setSocialsRows(rs => [...rs, { platform: 'Instagram', handle: '', artist: '', amount: '' }])}
              className="text-xs text-boom-600 hover:text-boom-700 font-semibold inline-flex items-center gap-1"
            >
              <Plus size={11} /> Add another
            </button>
          </div>
          {/* Running total of per-creator amounts vs the deal total. */}
          {(() => {
            const sum = socialsRows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0)
            if (!(sum > 0)) return null
            const deal = deals.find(d => d.id === socialsModal.dealId)
            const cur = deal?.currency || 'USD'
            const dealAmt = deal != null ? Number(deal.combined_amount || deal.amount) : null
            const balanced = dealAmt != null && Math.abs(sum - dealAmt) < 0.01
            return (
              <div className={`text-xs rounded-lg px-3 py-2 mt-3 flex items-center justify-between ${
                dealAmt == null
                  ? 'bg-gray-50 text-gray-600 ring-1 ring-gray-200/60'
                  : balanced
                    ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/60'
                    : 'bg-amber-50 text-amber-700 ring-1 ring-amber-200/60'
              }`}>
                <span className="font-semibold">
                  Total: <span className="tabular-nums">{fmt(sum, cur)}</span>
                  {dealAmt != null && <> of <span className="tabular-nums">{fmt(dealAmt, cur)}</span> deal</>}
                </span>
                {dealAmt != null && !balanced && (
                  <span className="font-bold tabular-nums">
                    {dealAmt - sum > 0 ? `${fmt(dealAmt - sum, cur)} left` : `${fmt(sum - dealAmt, cur)} over`}
                  </span>
                )}
                {balanced && <CheckCircle2 size={13} />}
              </div>
            )
          })()}
          <div className="flex justify-end gap-2 mt-4 pt-3 border-t border-rule">
            <button onClick={() => setSocialsModal(null)} disabled={socialsSaving} className="btn-secondary text-xs">Cancel</button>
            <button onClick={saveSocials} disabled={socialsSaving} className="btn-primary text-xs">
              {socialsSaving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
