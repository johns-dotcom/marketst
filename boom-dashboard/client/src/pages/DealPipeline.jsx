// The deal pipeline, second pass (2026-09-20). The BOARD is the four live
// stages; Signed and Passed fold away below it. Every filter lives in the URL
// (q owner type priority stage attn sort view deal), the same deals feed a
// LIST and a funnel REPORT, and ?deal=ID opens a card — Flags, the calendar
// and My Work link in that way.
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Plus, X, LayoutGrid, List as ListIcon, BarChart3, Search, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react'
import api from '../api'
import Skeleton from '../components/Skeleton'
import PageHeader from '../components/PageHeader'
import usePageShortcuts from '../hooks/usePageShortcuts'
import useListKeys, { focusFilter } from '../hooks/useListKeys'
import EmptyState from '../components/EmptyState'
import NextStepPrompt, { useNextStep } from '../components/NextStepPrompt'
import { useAuth } from '../context/AuthContext'
import DealCard from '../components/deals/DealCard'
import DealDrawer from '../components/deals/DealDrawer'
import DealList from '../components/deals/DealList'
import DealFunnel from '../components/deals/DealFunnel'
import PassedModal from '../components/deals/PassedModal'
import { STAGES, LIVE_STAGES, CLOSED_STAGES, PRIORITIES, DEAL_TYPES, STAGE_DOT, STAGE_HEADER, FILTER_KEYS, filterDeals, sortDeals, sumAdvance, fmtMoney, needsAttention } from '../lib/deals'

const CLOSED_OPEN_KEY = 'deals_closed_open_v1'

export default function DealPipeline() {
  const { user } = useAuth()
  const [deals, setDeals] = useState([])
  const [team, setTeam] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [nextStep, showNextStep, clearNextStep] = useNextStep()
  const [searchParams, setSearchParams] = useSearchParams()
  const filters = useMemo(() => Object.fromEntries(FILTER_KEYS.map((k) => [k, searchParams.get(k) || ''])), [searchParams])
  const setFilter = useCallback((patch) => {
    const next = new URLSearchParams(searchParams)
    for (const [k, v] of Object.entries(patch)) { if (v === '' || v === null || v === undefined) next.delete(k); else next.set(k, String(v)) }
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])
  const view = filters.view === 'list' || filters.view === 'report' ? filters.view : 'board'

  // ?new=1 (Home's quick action) opens the new-deal form on arrival
  const [showForm, setShowForm] = useState(() => searchParams.get('new') === '1')
  useEffect(() => { if (searchParams.get('new') === '1') { const n = new URLSearchParams(searchParams); n.delete('new'); setSearchParams(n, { replace: true }) } }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const blankForm = () => ({ artist_name: '', genre: '', stage: 'Scouting', owner_id: user?.id || '', source: '', notes: '', priority: 'Medium', deal_type: '', next_followup_date: '' })
  const [formData, setFormData] = useState(blankForm)
  const [passing, setPassing] = useState(null) // { deal, revert }
  const [closedOpen, setClosedOpen] = useState(() => { try { return JSON.parse(localStorage.getItem(CLOSED_OPEN_KEY) || '{}') } catch { return {} } })
  const toggleClosed = (stage) => setClosedOpen((o) => { const n = { ...o, [stage]: !o[stage] }; try { localStorage.setItem(CLOSED_OPEN_KEY, JSON.stringify(n)) } catch { /* private mode */ } return n })

  const load = async () => {
    try { setLoading(true); const r = await api.get('/deals'); setDeals(r.data.data || []) } catch { setError('Failed to load deals') } finally { setLoading(false) }
  }
  useEffect(() => { load(); api.get('/team').then((r) => setTeam(r.data?.data || [])).catch(() => {}) }, [])

  // The selected deal is the URL's ?deal= — a link from Flags or the calendar opens it.
  const selectedDeal = useMemo(() => deals.find((d) => String(d.id) === filters.deal) || null, [deals, filters.deal])
  const openDeal = (d) => setFilter({ deal: d ? d.id : '' })

  // ── keys: n new · f filter · j/k/Enter through cards and rows · m move to the next stage
  const keys = useListKeys({ enabled: !selectedDeal && !passing && !showForm })
  usePageShortcuts('/deals', {
    n: () => setShowForm(true),
    f: () => focusFilter(),
    j: () => keys.next(), k: () => keys.prev(), Enter: () => keys.open(), m: () => keys.verb('m'),
  })

  // ── Signing hand-off (unchanged): the server already ran it; say what it did.
  const promptSigned = (deal, signing) => {
    if (!deal?.artist_name) return
    const did = []
    if (signing?.created?.artist) did.push('added to the roster'); else if (signing?.artist) did.push('matched to the roster')
    if (signing?.created?.advance) did.push('advance invoice created (Net 30)'); else if (signing?.advance_expense_id) did.push('advance invoice already on Payments'); else if (!(Number(deal.advance) > 0)) did.push('no advance on this deal')
    const body = signing?.error
      ? `${signing.error} Then the contract: the form opens with the artist and the terms filled in.`
      : `${did.length ? did.map((d, i) => (i === 0 ? d.charAt(0).toUpperCase() + d.slice(1) : d)).join(', ') + '. ' : ''}Next is the contract — the form opens with the artist and the deal's terms filled in.`
    showNextStep({ title: `${deal.artist_name} is signed`, body, to: `/contracts?new=1&artist=${encodeURIComponent(deal.artist_name)}&deal=${deal.id}`, label: 'Create the contract' })
  }

  const upsert = (updated, signing) => {
    if (!updated) return
    setDeals((prev) => prev.map((d) => (d.id === updated.id ? updated : d)))
    if (signing) promptSigned(updated, signing)
  }

  const handleAddDeal = async (e) => {
    e.preventDefault()
    try {
      const r = await api.post('/deals', { ...formData, deal_type: formData.deal_type || null, priority: formData.priority || 'Medium', owner_id: formData.owner_id || null, next_followup_date: formData.next_followup_date || null })
      setDeals((prev) => [r.data.data, ...prev]); setFormData(blankForm()); setShowForm(false)
      if (r.data.signing) promptSigned(r.data.data, r.data.signing)
    } catch (err) { setError(err?.response?.data?.error || 'Failed to add deal') }
  }
  const handleDeleteDeal = async (dealId) => {
    if (!window.confirm('Delete this deal? Its timeline goes with it.')) return
    try { await api.delete(`/deals/${dealId}`); setDeals((prev) => prev.filter((d) => d.id !== dealId)); if (filters.deal === String(dealId)) openDeal(null) } catch { setError('Failed to delete deal') }
  }

  // A move to Passed asks why first; the card is moved optimistically and put back on Cancel.
  const moveStage = (deal, stage, extra) => {
    if (stage === deal.stage && stage !== 'Passed') return
    if (stage === 'Passed' && !extra) {
      const revert = deal.stage
      if (revert !== 'Passed') setDeals((prev) => prev.map((d) => (d.id === deal.id ? { ...d, stage: 'Passed' } : d)))
      setPassing({ deal, revert })
      return
    }
    setDeals((prev) => prev.map((d) => (d.id === deal.id ? { ...d, stage } : d)))
    api.put(`/deals/${deal.id}`, { stage, ...(extra || {}) })
      .then((r) => upsert(r.data.data, stage === 'Signed' ? (r.data.signing || {}) : null))
      .catch((err) => { setError(err?.response?.data?.error || 'Could not move the deal'); load() })
  }
  const confirmPassed = (fields) => { const { deal } = passing; setPassing(null); moveStage(deal, 'Passed', fields) }
  const cancelPassed = () => { const { deal, revert } = passing; setPassing(null); if (revert !== 'Passed') setDeals((prev) => prev.map((d) => (d.id === deal.id ? { ...d, stage: revert } : d))) }

  // ── Drag ──
  const [draggedDealId, setDraggedDealId] = useState(null)
  const [dragOverStage, setDragOverStage] = useState(null)
  const dragCounters = useRef({})
  const onDragStart = (e, dealId) => { setDraggedDealId(dealId); e.dataTransfer.effectAllowed = 'move'; requestAnimationFrame(() => { e.target.style.opacity = '0.4' }) }
  const onDragEnd = (e) => { e.target.style.opacity = '1'; setDraggedDealId(null); setDragOverStage(null); dragCounters.current = {} }
  const onDragEnter = (e, stage) => { e.preventDefault(); dragCounters.current[stage] = (dragCounters.current[stage] || 0) + 1; setDragOverStage(stage) }
  const onDragLeave = (e, stage) => { dragCounters.current[stage] = (dragCounters.current[stage] || 0) - 1; if (dragCounters.current[stage] <= 0) { dragCounters.current[stage] = 0; if (dragOverStage === stage) setDragOverStage(null) } }
  const onDragOver = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }
  const onDrop = (e, stage) => {
    e.preventDefault(); dragCounters.current = {}; setDragOverStage(null)
    if (draggedDealId == null) return
    const deal = deals.find((d) => d.id === draggedDealId)
    if (deal && deal.stage !== stage) moveStage(deal, stage)
    setDraggedDealId(null)
  }
  const dropProps = (stage) => ({ onDragEnter: (e) => onDragEnter(e, stage), onDragLeave: (e) => onDragLeave(e, stage), onDragOver, onDrop: (e) => onDrop(e, stage) })
  const isDropTarget = (stage) => { const dd = deals.find((d) => d.id === draggedDealId); return dragOverStage === stage && dd && dd.stage !== stage }

  // ── The set on screen ──
  const visible = useMemo(() => sortDeals(filterDeals(deals, filters, user?.id), filters.sort), [deals, filters, user?.id])
  const grouped = useMemo(() => { const g = {}; for (const s of STAGES) g[s] = visible.filter((d) => d.stage === s); return g }, [visible])
  const live = deals.filter((d) => LIVE_STAGES.includes(d.stage))
  const attnCount = deals.filter(needsAttention).length
  const activeFilters = ['q', 'owner', 'type', 'priority', 'stage', 'attn'].filter((k) => filters[k]).length
  const cardProps = (deal) => ({ deal, dragging: draggedDealId === deal.id, onOpen: openDeal, onDelete: handleDeleteDeal, onNext: (d, s) => moveStage(d, s), onDragStart, onDragEnd })

  if (loading) return <div className="space-y-6"><Skeleton.PageHeader /><Skeleton.KanbanBoard cols={4} cards={2} /></div>

  return (
    <div className="space-y-4">
      <PageHeader tour="deals-header" title="Deal Pipeline"
        subtitle={deals.length ? `${live.length} live · ${fmtMoney(sumAdvance(live))} in advances · ${grouped.Signed.length + deals.filter((d) => d.stage === 'Signed').length - grouped.Signed.length} signed · ${deals.filter((d) => d.stage === 'Passed').length} passed${attnCount ? ` · ${attnCount} need attention` : ''}` : 'Track a prospect from first meeting to signed'}
        actions={(
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-lg border border-rule bg-card p-0.5" role="tablist" data-tour="deals-views" data-deals-views>
              {[['board', LayoutGrid, 'Board'], ['list', ListIcon, 'List'], ['report', BarChart3, 'Report']].map(([id, Icon, label]) => (
                <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => setFilter({ view: id === 'board' ? '' : id })} data-deals-view={id}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium ${view === id ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'}`}><Icon size={13} /> <span className="hidden sm:inline">{label}</span></button>
              ))}
            </div>
            <button data-tour="deals-new" onClick={() => setShowForm((v) => !v)} className="btn-primary"><Plus size={16} /> New Deal</button>
          </div>
        )} />

      {/* Filters — the URL is the state */}
      {view !== 'report' && (
        <div className="flex items-center gap-2 flex-wrap" data-tour="deals-filters" data-deals-filters>
          <label className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input value={filters.q} onChange={(e) => setFilter({ q: e.target.value })} placeholder="Search artist, genre, source, notes…" data-filter className="input-base pl-7 py-1.5 text-sm w-60" aria-label="Search deals" />
          </label>
          <select value={filters.owner} onChange={(e) => setFilter({ owner: e.target.value })} className="select-base text-xs py-1.5" aria-label="Owner" data-deals-owner-filter>
            <option value="">Everyone</option><option value="me">Mine</option>
            {team.filter((m) => String(m.id) !== String(user?.id)).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <select value={filters.type} onChange={(e) => setFilter({ type: e.target.value })} className="select-base text-xs py-1.5" aria-label="Deal type"><option value="">Any type</option>{DEAL_TYPES.map((t) => <option key={t}>{t}</option>)}</select>
          <select value={filters.priority} onChange={(e) => setFilter({ priority: e.target.value })} className="select-base text-xs py-1.5" aria-label="Priority"><option value="">Any priority</option>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select>
          {view === 'list' && <select value={filters.stage} onChange={(e) => setFilter({ stage: e.target.value })} className="select-base text-xs py-1.5" aria-label="Stage"><option value="">Any stage</option>{STAGES.map((s) => <option key={s}>{s}</option>)}</select>}
          <button type="button" onClick={() => setFilter({ attn: filters.attn === '1' ? '' : '1' })} aria-pressed={filters.attn === '1'} data-deals-attn
            className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border ${filters.attn === '1' ? 'bg-rose-600 text-white border-rose-600' : 'bg-card text-gray-600 border-rule hover:bg-gray-50'}`}>
            <AlertTriangle size={12} /> Needs attention{attnCount ? ` · ${attnCount}` : ''}
          </button>
          {activeFilters > 0 && <button type="button" onClick={() => setFilter({ q: '', owner: '', type: '', priority: '', stage: '', attn: '' })} className="text-xs text-gray-500 hover:text-gray-900 inline-flex items-center gap-1" data-deals-clear><X size={11} /> Clear</button>}
        </div>
      )}

      {/* New deal */}
      {showForm && (
        <div className="bg-card border border-rule rounded-xl p-5 shadow-sm" data-deal-form>
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-sm font-semibold text-gray-900">Add New Deal</h2>
            <button onClick={() => setShowForm(false)} aria-label="Close" className="p-1 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"><X size={18} /></button>
          </div>
          <form onSubmit={handleAddDeal} className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <input type="text" placeholder="Artist Name" value={formData.artist_name} onChange={(e) => setFormData({ ...formData, artist_name: e.target.value })} required className="input-base" aria-label="Artist name" />
              <input type="text" placeholder="Genre" value={formData.genre} onChange={(e) => setFormData({ ...formData, genre: e.target.value })} className="input-base" aria-label="Genre" />
              <select value={formData.stage} onChange={(e) => setFormData({ ...formData, stage: e.target.value })} className="select-base w-full" aria-label="Stage">{STAGES.map((s) => <option key={s} value={s}>{s}</option>)}</select>
              <select value={formData.owner_id} onChange={(e) => setFormData({ ...formData, owner_id: e.target.value })} className="select-base w-full" aria-label="Owner" data-form-owner>
                {team.map((m) => <option key={m.id} value={m.id}>{String(m.id) === String(user?.id) ? `Owner: me` : `Owner: ${m.name}`}</option>)}
                {!team.length && <option value={user?.id || ''}>Owner: me</option>}
              </select>
              <input type="text" placeholder="Source (referral, showcase, inbound…)" value={formData.source} onChange={(e) => setFormData({ ...formData, source: e.target.value })} className="input-base" aria-label="Source" />
              <select value={formData.priority} onChange={(e) => setFormData({ ...formData, priority: e.target.value })} className="select-base w-full" aria-label="Priority">{PRIORITIES.map((p) => <option key={p} value={p}>{`Priority: ${p}`}</option>)}</select>
              <select value={formData.deal_type} onChange={(e) => setFormData({ ...formData, deal_type: e.target.value })} className="select-base w-full" aria-label="Deal type"><option value="">Deal Type (optional)</option>{DEAL_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select>
              <label className="block"><input type="date" value={formData.next_followup_date} onChange={(e) => setFormData({ ...formData, next_followup_date: e.target.value })} className="input-base w-full" aria-label="First follow-up" title="First follow-up" /><span className="text-[10px] text-gray-400">First follow-up (optional)</span></label>
            </div>
            <textarea placeholder="First note — where they came from, what they want" value={formData.notes} onChange={(e) => setFormData({ ...formData, notes: e.target.value })} className="input-base w-full" rows="2" aria-label="Notes" />
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => setShowForm(false)} className="btn-secondary">Cancel</button>
              <button type="submit" className="btn-primary" data-deal-form-submit>Add Deal</button>
            </div>
          </form>
        </div>
      )}

      {error && <div className="text-sm text-red-600 flex items-center justify-between bg-red-50 border border-red-200 rounded-lg px-3 py-2"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss" className="p-0.5"><X size={14} /></button></div>}
      <NextStepPrompt prompt={nextStep} onClose={clearNextStep} />

      {view === 'report' && <DealFunnel />}

      {view === 'list' && <DealList deals={visible} sort={filters.sort} onSort={(s) => setFilter({ sort: s })} onOpen={openDeal} />}

      {view === 'board' && (
        <div className="space-y-3" data-tour="deal-board" data-deal-board>
          {deals.length === 0 && !showForm ? (
            <EmptyState title="No deals in the pipeline" body="Track a prospect from first meeting to signed. A deal marked Signed becomes a roster artist, an advance invoice and a contract." action={{ label: 'New deal', onClick: () => setShowForm(true) }} />
          ) : (
            <>
              {visible.length === 0 && <p className="text-sm text-gray-400 text-center py-3" data-deals-nomatch>No deals match these filters. <button type="button" className="underline" onClick={() => setFilter({ q: '', owner: '', type: '', priority: '', stage: '', attn: '' })}>Clear filters</button></p>}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {LIVE_STAGES.map((stage) => {
                  const col = grouped[stage]; const target = isDropTarget(stage)
                  return (
                    <div key={stage} data-tour="deal-column" data-deal-column={stage} {...dropProps(stage)}
                      className={`rounded-xl border bg-card p-3 min-h-[12rem] transition-all duration-150 ${target ? 'border-gray-400 bg-gray-50 ring-1 ring-gray-300' : 'border-rule'}`}>
                      <div className="flex items-center gap-2 mb-3 pb-2 border-b border-divider">
                        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${STAGE_DOT[stage]}`} />
                        <h3 className={`text-[11px] font-bold uppercase tracking-wider flex-1 ${STAGE_HEADER[stage]}`}>{stage}</h3>
                        {sumAdvance(col) > 0 && <span className="text-[10px] font-semibold text-gray-500 tabular-nums" data-column-sum>{fmtMoney(sumAdvance(col))}</span>}
                        {col.length > 0 && <span className="text-[10px] font-bold text-gray-400 bg-gray-100 rounded px-1.5 py-0.5 tabular-nums" data-column-count>{col.length}</span>}
                      </div>
                      <div className="space-y-2">{col.map((deal) => <DealCard key={deal.id} {...cardProps(deal)} />)}</div>
                      {target && col.length === 0 && <div className="border-2 border-dashed border-gray-300 rounded-lg p-3 text-center text-[11px] text-gray-400 font-medium">Drop here</div>}
                    </div>
                  )
                })}
              </div>
              {/* Signed and Passed fold away: the board is the work, these are the record. Still drop targets. */}
              <div className="grid md:grid-cols-2 gap-3" data-tour="deals-closed" data-deals-closed>
                {CLOSED_STAGES.map((stage) => {
                  const col = grouped[stage]; const all = deals.filter((d) => d.stage === stage); const open = !!closedOpen[stage]; const target = isDropTarget(stage)
                  return (
                    <div key={stage} data-deal-column={stage} data-open={open ? '1' : '0'} {...dropProps(stage)}
                      className={`rounded-xl border bg-card transition-all duration-150 ${target ? 'border-gray-400 bg-gray-50 ring-1 ring-gray-300' : 'border-rule'}`}>
                      <button type="button" onClick={() => toggleClosed(stage)} className="w-full flex items-center gap-2 px-3 py-2.5 text-left" aria-expanded={open} data-closed-toggle={stage}>
                        {open ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />}
                        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${STAGE_DOT[stage]}`} />
                        <h3 className={`text-[11px] font-bold uppercase tracking-wider ${STAGE_HEADER[stage]}`}>{stage}</h3>
                        <span className="text-[11px] text-gray-500 tabular-nums">{col.length}{col.length !== all.length ? ` of ${all.length}` : ''}{stage === 'Signed' && sumAdvance(col) > 0 ? ` · ${fmtMoney(sumAdvance(col))} in advances` : ''}</span>
                        {target && <span className="ml-auto text-[11px] text-gray-500 font-medium">Drop to mark {stage.toLowerCase()}</span>}
                      </button>
                      {open && (
                        <div className="px-3 pb-3 grid sm:grid-cols-2 gap-2">
                          {col.length === 0 && <p className="text-xs text-gray-400 col-span-2">{stage === 'Signed' ? 'Nothing signed yet.' : 'Nothing passed on yet.'}</p>}
                          {col.map((deal) => <DealCard key={deal.id} {...cardProps(deal)} />)}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>
      )}

      {selectedDeal && (
        <DealDrawer deal={selectedDeal} team={team} user={user} onClose={() => openDeal(null)} onSaved={upsert}
          onMoveStage={(deal, stage) => { if (stage === 'Passed') setPassing({ deal, revert: deal.stage }); else moveStage(deal, stage) }}
          onFileCount={(id, count) => setDeals((prev) => prev.map((d) => (d.id === id ? { ...d, file_count: count } : d)))} />
      )}
      {passing && <PassedModal deal={passing.deal} onConfirm={confirmPassed} onCancel={cancelPassed} />}
    </div>
  )
}
