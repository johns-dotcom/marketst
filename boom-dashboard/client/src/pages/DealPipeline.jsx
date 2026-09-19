import { useState, useEffect, useRef } from 'react'
import { Plus, X, ChevronRight, Paperclip, GripVertical, Save, Check } from 'lucide-react'
import api from '../api'
import { formatDate } from '../utils'
import Skeleton from '../components/Skeleton'
import PageHeader from '../components/PageHeader'
import FilesPanel from '../components/FilesPanel'
import useHotkeys from '../hooks/useHotkeys'
import { Button, Input, Select } from '../components/ui'
import EmptyState from '../components/EmptyState'
import NextStepPrompt, { useNextStep } from '../components/NextStepPrompt'

const STAGES = ['Scouting', 'Meeting', 'Offer', 'Negotiation', 'Signed', 'Passed']
const PRIORITIES = ['High', 'Medium', 'Low']
const DEAL_TYPES = ['360 Deal', 'Master License', 'Single License', 'Distribution', 'Publishing', 'Other']

// Mirrors the bg/text/border colors used in the kanban-card priority pill, so
// the priority <select> in the drawer reads as the same shape of UI element.
const PRIORITY_SELECT_TONE = {
  High:   'bg-red-50 text-red-700 border-red-200 focus:border-red-300',
  Medium: 'bg-amber-50 text-amber-700 border-amber-200 focus:border-amber-300',
  Low:    'bg-gray-100 text-gray-700 border-gray-200 focus:border-gray-300',
}

const PRIORITY_PILL_TONE = {
  High:   'bg-red-100 text-red-700',
  Medium: 'bg-amber-100 text-amber-700',
  Low:    'bg-gray-100 text-gray-600',
}

// Short "Jun 12" form for kanban-card follow-up dates. Built off the local
// date parts so we don't get bitten by the same UTC drift formatDate guards
// against.
function formatShortDate(dateStr) {
  if (!dateStr) return ''
  const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return ''
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${months[parseInt(m[2], 10) - 1]} ${parseInt(m[3], 10)}`
}

function isOverdue(dateStr) {
  if (!dateStr) return false
  // Pure string comparison on 'YYYY-MM-DD' — but "today" must be the LOCAL
  // date; toISOString() is UTC, which is tomorrow after ~5pm PT and made
  // today's follow-ups read overdue every evening.
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const target = String(dateStr).slice(0, 10)
  return target < today
}

const STAGE_DOT = {
  Scouting:    'bg-gray-400',
  Meeting:     'bg-blue-500',
  Offer:       'bg-amber-500',
  Negotiation: 'bg-violet-500',
  Signed:      'bg-emerald-500',
  Passed:      'bg-gray-300',
}

const STAGE_HEADER = {
  Scouting:    'text-gray-600',
  Meeting:     'text-blue-600',
  Offer:       'text-amber-600',
  Negotiation: 'text-violet-600',
  Signed:      'text-emerald-600',
  Passed:      'text-gray-400',
}

export default function DealPipeline() {
  const [deals, setDeals] = useState([])
  // The hand-off. A deal marked Signed is the moment a contract starts; the
  // prompt opens the contract form with the artist filled in (and offers to
  // put them on the roster if the deal named someone not yet on it).
  const [nextStep, showNextStep, clearNextStep] = useNextStep()
  const promptSigned = (deal) => {
    if (!deal?.artist_name) return
    showNextStep({
      title: `${deal.artist_name} is signed`,
      body: 'Next is the contract. The form opens with the artist filled in; if they are not on the roster yet, it adds them.',
      to: `/contracts?new=1&artist=${encodeURIComponent(deal.artist_name)}&deal=${deal.id}`,
      label: 'Create the contract',
    })
  }
  const [showForm, setShowForm] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [formData, setFormData] = useState({
    artist_name: '', genre: '', stage: 'Scouting', ar_rep: '', source: '', notes: '',
    priority: 'Medium', deal_type: '',
  })
  const [selectedDeal, setSelectedDeal] = useState(null)
  const [editForm, setEditForm] = useState({})
  const [savingEdit, setSavingEdit] = useState(false)
  const [editStatus, setEditStatus] = useState('') // '', 'saved', 'error'

  useHotkeys([
    { key: 'n', handler: () => setShowForm(true) },
  ])
  const [dealFileCounts, setDealFileCounts] = useState({})

  // Re-hydrate the editable fields whenever a different deal is opened.
  // Tracked by id so opening the same deal twice doesn't blow away in-flight
  // edits, and so a fresh PUT response (which also lands in selectedDeal)
  // doesn't reset the form mid-typing.
  useEffect(() => {
    if (!selectedDeal) return
    setEditForm({
      last_contact_date:         (selectedDeal.last_contact_date || '').slice(0, 10),
      next_followup_date:        (selectedDeal.next_followup_date || '').slice(0, 10),
      priority:                  selectedDeal.priority || 'Medium',
      spotify_monthly_listeners: selectedDeal.spotify_monthly_listeners ?? '',
      deal_type:                 selectedDeal.deal_type || '',
      offer_amount:              selectedDeal.offer_amount ?? '',
    })
    setEditStatus('')
  }, [selectedDeal?.id])

  const handleSaveEdit = async () => {
    if (!selectedDeal) return
    setSavingEdit(true)
    try {
      const listeners = editForm.spotify_monthly_listeners
      const offer = editForm.offer_amount
      const payload = {
        last_contact_date:         editForm.last_contact_date || null,
        next_followup_date:        editForm.next_followup_date || null,
        priority:                  editForm.priority || null,
        spotify_monthly_listeners: listeners === '' || listeners == null ? null : Number(listeners),
        deal_type:                 editForm.deal_type || null,
        offer_amount:              offer === '' || offer == null ? null : Number(offer),
      }
      const response = await api.put(`/deals/${selectedDeal.id}`, payload)
      if (payload.stage === 'Signed' && selectedDeal.stage !== 'Signed') promptSigned(response.data.data)
      const updated = response.data.data
      setDeals(prev => prev.map(d => d.id === updated.id ? updated : d))
      setSelectedDeal(updated)
      setEditStatus('saved')
      setTimeout(() => setEditStatus(prev => prev === 'saved' ? '' : prev), 2000)
    } catch (err) {
      console.error('Failed to save deal edits:', err)
      setEditStatus('error')
    } finally {
      setSavingEdit(false)
    }
  }

  // Drag state
  const [draggedDealId, setDraggedDealId] = useState(null)
  const [dragOverStage, setDragOverStage] = useState(null)
  const dragCounters = useRef({})

  useEffect(() => { fetchDeals() }, [])

  const fetchDeals = async () => {
    try {
      setLoading(true)
      const response = await api.get('/deals')
      setDeals(response.data.data || [])
    } catch (err) {
      setError('Failed to load deals')
    } finally {
      setLoading(false)
    }
  }

  const handleAddDeal = async (e) => {
    e.preventDefault()
    try {
      // Server destructures priority/deal_type; empty deal_type sent as null
      // so we don't bypass the allowlist with a '' value.
      const payload = {
        ...formData,
        deal_type: formData.deal_type || null,
        priority: formData.priority || 'Medium',
      }
      const response = await api.post('/deals', payload)
      setDeals([...deals, response.data.data])
      setFormData({
        artist_name: '', genre: '', stage: 'Scouting', ar_rep: '', source: '', notes: '',
        priority: 'Medium', deal_type: '',
      })
      setShowForm(false)
    } catch (err) {
      alert('Failed to add deal')
    }
  }

  const handleDeleteDeal = async (dealId) => {
    if (!window.confirm('Delete this deal?')) return
    try {
      await api.delete(`/deals/${dealId}`)
      setDeals(deals.filter(d => d.id !== dealId))
    } catch (err) {
      alert('Failed to delete deal')
    }
  }

  const handleChangeStage = async (dealId, newStage) => {
    try {
      const response = await api.put(`/deals/${dealId}`, { stage: newStage })
      // Functional update — the closure's `deals` predates the optimistic
      // drop update, so rapid drags could visually snap a card back.
      setDeals(prev => prev.map(d => d.id === dealId ? response.data.data : d))
      if (newStage === 'Signed') promptSigned(response.data.data)
    } catch (err) {
      console.error('Failed to update deal:', err)
    }
  }

  // ── Drag handlers ──
  const onDragStart = (e, dealId) => {
    setDraggedDealId(dealId)
    e.dataTransfer.effectAllowed = 'move'
    requestAnimationFrame(() => { e.target.style.opacity = '0.4' })
  }
  const onDragEnd = (e) => {
    e.target.style.opacity = '1'
    setDraggedDealId(null)
    setDragOverStage(null)
    dragCounters.current = {}
  }
  const onDragEnter = (e, stage) => {
    e.preventDefault()
    dragCounters.current[stage] = (dragCounters.current[stage] || 0) + 1
    setDragOverStage(stage)
  }
  const onDragLeave = (e, stage) => {
    dragCounters.current[stage] = (dragCounters.current[stage] || 0) - 1
    if (dragCounters.current[stage] <= 0) {
      dragCounters.current[stage] = 0
      if (dragOverStage === stage) setDragOverStage(null)
    }
  }
  const onDragOver = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }
  const onDrop = (e, stage) => {
    e.preventDefault()
    dragCounters.current = {}
    setDragOverStage(null)
    if (draggedDealId == null) return
    const deal = deals.find(d => d.id === draggedDealId)
    if (deal && deal.stage !== stage) {
      setDeals(prev => prev.map(d => d.id === draggedDealId ? { ...d, stage } : d))
      handleChangeStage(draggedDealId, stage)
    }
    setDraggedDealId(null)
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton.PageHeader />
        <Skeleton.KanbanBoard cols={6} cards={2} />
      </div>
    )
  }

  const grouped = {}
  STAGES.forEach(s => { grouped[s] = deals.filter(d => d.stage === s) })

  return (
    <div className="space-y-5">
      {/* Header */}
      <PageHeader
        title="Deal Pipeline"
        subtitle={`${deals.length} deal${deals.length !== 1 ? 's' : ''} across ${STAGES.length} stages`}
        actions={<button onClick={() => setShowForm(!showForm)} className="btn-primary"><Plus size={16} /> New Deal</button>}
      />

      {/* Add Deal Form */}
      {showForm && (
        <div className="bg-card border border-rule rounded-xl p-5 shadow-sm">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-sm font-semibold text-gray-900">Add New Deal</h2>
            <button onClick={() => setShowForm(false)} className="p-1 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100">
              <X size={18} />
            </button>
          </div>
          <form onSubmit={handleAddDeal} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <input type="text" placeholder="Artist Name" value={formData.artist_name} onChange={e => setFormData({ ...formData, artist_name: e.target.value })} required className="input-base" />
              <input type="text" placeholder="Genre" value={formData.genre} onChange={e => setFormData({ ...formData, genre: e.target.value })} className="input-base" />
              <select value={formData.stage} onChange={e => setFormData({ ...formData, stage: e.target.value })} className="select-base w-full">
                {STAGES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <input type="text" placeholder="A&R Rep" value={formData.ar_rep} onChange={e => setFormData({ ...formData, ar_rep: e.target.value })} className="input-base" />
              <input type="text" placeholder="Source" value={formData.source} onChange={e => setFormData({ ...formData, source: e.target.value })} className="input-base" />
              <select value={formData.priority} onChange={e => setFormData({ ...formData, priority: e.target.value })} className="select-base w-full">
                {PRIORITIES.map(p => <option key={p} value={p}>{`Priority: ${p}`}</option>)}
              </select>
              <select value={formData.deal_type} onChange={e => setFormData({ ...formData, deal_type: e.target.value })} className="select-base w-full">
                <option value="">Deal Type (optional)</option>
                {DEAL_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <textarea placeholder="Notes" value={formData.notes} onChange={e => setFormData({ ...formData, notes: e.target.value })} className="input-base" rows="2" />
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => setShowForm(false)} className="btn-secondary">Cancel</button>
              <button type="submit" className="btn-primary">Add Deal</button>
            </div>
          </form>
        </div>
      )}

      {error && <div className="text-sm text-red-600 text-center py-12">{error}</div>}

      {!loading && !error && deals.length === 0 && !showForm && (
        <EmptyState
          title="No deals in the pipeline"
          body="Track a prospect from first meeting to signed. A deal marked Signed is what becomes a contract."
          action={{ label: 'New deal', onClick: () => setShowForm(true) }}
        />
      )}

      <NextStepPrompt prompt={nextStep} onClose={clearNextStep} />

      {/* Kanban Board */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {STAGES.map(stage => {
          const isDropTarget = dragOverStage === stage && draggedDealId != null
          const draggedDeal = deals.find(d => d.id === draggedDealId)
          const isDifferentStage = draggedDeal && draggedDeal.stage !== stage
          const count = grouped[stage].length

          return (
            <div
              key={stage}
              className={`rounded-xl border bg-card p-3 min-h-[16rem] transition-all duration-150 ${
                isDropTarget && isDifferentStage
                  ? 'border-gray-400 bg-gray-50 ring-1 ring-gray-300'
                  : 'border-rule'
              }`}
              onDragEnter={e => onDragEnter(e, stage)}
              onDragLeave={e => onDragLeave(e, stage)}
              onDragOver={onDragOver}
              onDrop={e => onDrop(e, stage)}
            >
              {/* Column header */}
              <div className="flex items-center gap-2 mb-3 pb-2 border-b border-divider">
                <div className={`w-2 h-2 rounded-full flex-shrink-0 ${STAGE_DOT[stage]}`} />
                <h3 className={`text-[11px] font-bold uppercase tracking-wider flex-1 ${STAGE_HEADER[stage]}`}>
                  {stage}
                </h3>
                {count > 0 && (
                  <span className="text-[10px] font-bold text-gray-400 bg-gray-100 rounded px-1.5 py-0.5 tabular-nums">
                    {count}
                  </span>
                )}
              </div>

              {/* Cards */}
              <div className="space-y-2">
                {grouped[stage].map(deal => (
                  <div
                    key={deal.id}
                    draggable
                    onDragStart={e => onDragStart(e, deal.id)}
                    onDragEnd={onDragEnd}
                    className={`p-2.5 rounded-lg border border-gray-150 hover:border-gray-300 bg-card hover:shadow-sm transition-all group ${
                      draggedDealId === deal.id ? 'opacity-30' : ''
                    }`}
                    style={{ cursor: 'grab' }}
                  >
                    <div className="flex items-start gap-1.5">
                      <GripVertical size={12} className="text-gray-300 mt-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                      <button onClick={() => setSelectedDeal(deal)} className="flex-1 min-w-0 text-left">
                        <p className="text-[13px] font-semibold text-gray-900 truncate leading-tight">{deal.artist_name}</p>
                        {deal.genre && <p className="text-[11px] text-gray-400 mt-0.5 truncate">{deal.genre}</p>}
                        {deal.ar_rep && <p className="text-[11px] text-gray-400 truncate">{deal.ar_rep}</p>}
                        {(deal.priority || deal.next_followup_date) && (
                          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                            {deal.priority && (
                              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider ${PRIORITY_PILL_TONE[deal.priority] || PRIORITY_PILL_TONE.Medium}`}>
                                {deal.priority}
                              </span>
                            )}
                            {deal.next_followup_date && (
                              <span className={`text-[10px] font-medium ${isOverdue(deal.next_followup_date) ? 'text-amber-600' : 'text-gray-400'}`}>
                                Follow up: {formatShortDate(deal.next_followup_date)}
                              </span>
                            )}
                          </div>
                        )}
                        {(dealFileCounts[deal.id] > 0) && (
                          <span className="inline-flex items-center gap-0.5 mt-1 text-[10px] font-medium text-gray-300">
                            <Paperclip size={9} /> {dealFileCounts[deal.id]}
                          </span>
                        )}
                      </button>
                      <button
                        onClick={() => handleDeleteDeal(deal.id)}
                        className="p-0.5 text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
                      >
                        <X size={12} />
                      </button>
                    </div>
                    {deal.stage !== STAGES[STAGES.length - 1] && (
                      <button
                        onClick={() => {
                          const next = STAGES.indexOf(deal.stage) + 1
                          if (next < STAGES.length) handleChangeStage(deal.id, STAGES[next])
                        }}
                        className="mt-1.5 w-full flex items-center justify-center gap-0.5 text-[11px] font-medium text-gray-400 hover:text-boom-600 py-0.5 rounded hover:bg-boom-50/50 transition-all"
                      >
                        Next <ChevronRight size={11} />
                      </button>
                    )}
                  </div>
                ))}
              </div>

              {/* Drop hint */}
              {isDropTarget && isDifferentStage && count === 0 && (
                <div className="border-2 border-dashed border-gray-300 rounded-lg p-3 text-center text-[11px] text-gray-400 font-medium">
                  Drop here
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Deal detail slide-over */}
      {selectedDeal && (
        <div className="fixed inset-0 z-50 flex justify-end" onClick={() => setSelectedDeal(null)}>
          <div className="relative w-full max-w-sm bg-card shadow-xl border-l border-rule h-full overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="sticky top-0 bg-card border-b border-divider px-5 py-4 flex items-start justify-between gap-3 z-10">
              <div className="min-w-0">
                <p className="text-base font-semibold text-gray-900 truncate">{selectedDeal.artist_name}</p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {selectedDeal.stage}{selectedDeal.genre && ` · ${selectedDeal.genre}`}{selectedDeal.ar_rep && ` · ${selectedDeal.ar_rep}`}
                </p>
              </div>
              <button onClick={() => setSelectedDeal(null)} className="p-1.5 text-gray-400 hover:text-gray-700 rounded-lg hover:bg-gray-100 transition-colors flex-shrink-0">
                <X size={16} />
              </button>
            </div>
            <div className="px-5 py-4 space-y-3 border-b border-divider">
              {selectedDeal.source && (
                <div>
                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-0.5">Source</p>
                  <p className="text-sm text-gray-700">{selectedDeal.source}</p>
                </div>
              )}
              {selectedDeal.notes && (
                <div>
                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-0.5">Notes</p>
                  <p className="text-sm text-gray-700 whitespace-pre-wrap">{selectedDeal.notes}</p>
                </div>
              )}
              {selectedDeal.added_date && (
                <p className="text-xs text-gray-400">Added {formatDate(selectedDeal.added_date)}</p>
              )}
            </div>
            {/* Deal details — editable */}
            <div className="px-5 py-4 border-b border-divider space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Details</p>
                {editStatus === 'saved' && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600 font-medium">
                    <Check size={11} /> Saved
                  </span>
                )}
                {editStatus === 'error' && (
                  <span className="text-[11px] text-red-600 font-medium">Save failed</span>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <label className="block">
                  <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Priority</span>
                  <Select
                    value={editForm.priority || 'Medium'}
                    onChange={e => setEditForm(f => ({ ...f, priority: e.target.value }))}
                    className={`mt-1 font-semibold ${PRIORITY_SELECT_TONE[editForm.priority] || PRIORITY_SELECT_TONE.Medium}`}
                  >
                    {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
                  </Select>
                </label>

                <label className="block">
                  <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Deal Type</span>
                  <Select
                    value={editForm.deal_type || ''}
                    onChange={e => setEditForm(f => ({ ...f, deal_type: e.target.value }))}
                    className="mt-1"
                  >
                    <option value="">—</option>
                    {DEAL_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                  </Select>
                </label>

                <label className="block">
                  <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Last Contact</span>
                  <Input
                    type="date"
                    value={editForm.last_contact_date || ''}
                    onChange={e => setEditForm(f => ({ ...f, last_contact_date: e.target.value }))}
                    className="mt-1"
                  />
                </label>

                <label className="block">
                  <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Next Follow-up</span>
                  <Input
                    type="date"
                    value={editForm.next_followup_date || ''}
                    onChange={e => setEditForm(f => ({ ...f, next_followup_date: e.target.value }))}
                    className="mt-1"
                  />
                </label>

                <label className="block">
                  <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Offer Amount</span>
                  <div className="relative mt-1">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400 pointer-events-none">$</span>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="0.00"
                      value={editForm.offer_amount ?? ''}
                      onChange={e => setEditForm(f => ({ ...f, offer_amount: e.target.value }))}
                      className="pl-7"
                    />
                  </div>
                </label>

                <label className="block">
                  <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Spotify Monthly</span>
                  <Input
                    inputMode="numeric"
                    placeholder="e.g. 250,000"
                    // Display comma-formatted; strip commas on edit so the
                    // raw value stored in state is always a clean integer
                    // string (the payload coerces it to Number on save).
                    value={
                      editForm.spotify_monthly_listeners === '' || editForm.spotify_monthly_listeners == null
                        ? ''
                        : Number(editForm.spotify_monthly_listeners).toLocaleString('en-US')
                    }
                    onChange={e => {
                      const raw = e.target.value.replace(/,/g, '')
                      if (raw === '' || /^\d+$/.test(raw)) {
                        setEditForm(f => ({ ...f, spotify_monthly_listeners: raw }))
                      }
                    }}
                    className="mt-1"
                  />
                </label>
              </div>

              <div className="flex justify-end pt-1">
                <Button
                  size="sm"
                  onClick={handleSaveEdit}
                  disabled={savingEdit}
                >
                  <Save size={13} />
                  {savingEdit ? 'Saving…' : 'Save Changes'}
                </Button>
              </div>
            </div>

            <div className="px-5 py-4 border-b border-divider">
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Move Stage</p>
              <div className="flex flex-wrap gap-1.5">
                {STAGES.map(s => (
                  <button
                    key={s}
                    onClick={() => {
                      if (s !== selectedDeal.stage) {
                        handleChangeStage(selectedDeal.id, s)
                        setSelectedDeal({ ...selectedDeal, stage: s })
                      }
                    }}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                      s === selectedDeal.stage ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="px-5 pt-4 pb-1">
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Documents</p>
              </div>
              <FilesPanel
                entityType="deal" entityId={selectedDeal.id} basePath="/deals"
                onCountChange={(count) => setDealFileCounts(prev => ({ ...prev, [selectedDeal.id]: count }))}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
