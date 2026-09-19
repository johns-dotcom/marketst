import { useState, useEffect, useCallback } from 'react'
import { Search, Plus, X, ChevronDown, FileText, Edit3, Trash2, RefreshCw } from 'lucide-react'
import api from '../api'
import PageHeader from '../components/PageHeader'
import EmptyState from '../components/EmptyState'

const STATUS_STYLES = {
  'Sent':     { pill: 'bg-emerald-50 text-emerald-700 ring-emerald-200', dot: 'bg-emerald-400' },
  'Not Sent': { pill: 'bg-gray-100 text-gray-500 ring-gray-200',         dot: 'bg-gray-400'    },
  'Signed':   { pill: 'bg-blue-50 text-blue-700 ring-blue-200',          dot: 'bg-blue-400'    },
  'Declined': { pill: 'bg-red-50 text-red-600 ring-red-200',             dot: 'bg-red-400'     },
}

function StatusBadge({ status }) {
  const s = STATUS_STYLES[status] || STATUS_STYLES['Not Sent']
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ring-1 ${s.pill}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {status || 'Not Sent'}
    </span>
  )
}

const EMPTY = {
  artist_name: '', legal_name: '', address: '', cash: '', split: '',
  years: '', options: '', back_signs: '', futures: '', status: 'Not Sent', email: '', notes: ''
}

function Field({ label, value, wide }) {
  if (!value) return null
  return (
    <div className={wide ? 'col-span-2' : ''}>
      <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1">{label}</p>
      <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">{value}</p>
    </div>
  )
}

function ContractModal({ item, onClose, onSaved }) {
  const isEdit = !!item
  const [form, setForm] = useState(isEdit ? { ...EMPTY, ...item } : EMPTY)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const save = async () => {
    if (!form.artist_name.trim()) { setError('Artist name is required'); return }
    setSaving(true)
    try {
      const res = isEdit
        ? await api.put(`/pending-contracts/${item.id}`, form)
        : await api.post('/pending-contracts', form)
      if (!res.data.success) throw new Error(res.data.error)
      onSaved(res.data.data)
    } catch (e) {
      setError(e.response?.data?.error || e.message)
      setSaving(false)
    }
  }

  const Input = ({ label, k, placeholder }) => (
    <div>
      <label className="block text-xs font-medium text-gray-500 mb-1.5">{label}</label>
      <input value={form[k]} onChange={e => set(k, e.target.value)} placeholder={placeholder}
        className="w-full px-3 py-2 bg-gray-50 border border-rule rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-boom/30 focus:border-boom focus:bg-card transition-all" />
    </div>
  )
  const Textarea = ({ label, k, placeholder, rows = 2 }) => (
    <div>
      <label className="block text-xs font-medium text-gray-500 mb-1.5">{label}</label>
      <textarea value={form[k]} onChange={e => set(k, e.target.value)} placeholder={placeholder} rows={rows}
        className="w-full px-3 py-2 bg-gray-50 border border-rule rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:ring-boom/30 focus:border-boom focus:bg-card transition-all" />
    </div>
  )

  return (
    <div className="fixed inset-0 bg-overlay backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-card rounded-2xl shadow-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-5 border-b border-divider">
          <h2 className="font-semibold text-gray-900">{isEdit ? `Edit — ${item.artist_name}` : 'Add Artist'}</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 transition-colors"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2"><Input label="Artist Name *" k="artist_name" placeholder="Stage name" /></div>
            <Input label="Legal Name / Company" k="legal_name" placeholder="Full legal name" />
            <Input label="Email" k="email" placeholder="manager@email.com" />
            <div className="col-span-2"><Textarea label="Address" k="address" placeholder="Full address" /></div>
            <Input label="Cash / Marketing" k="cash" placeholder="e.g. 20k marketing" />
            <Input label="Split" k="split" placeholder="e.g. 50/50" />
            <Input label="Term / Years" k="years" placeholder="e.g. perp or 10 years" />
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1.5">Status</label>
              <select value={form.status} onChange={e => set('status', e.target.value)}
                className="w-full px-3 py-2 bg-gray-50 border border-rule rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-boom/30 focus:border-boom transition-all">
                {Object.keys(STATUS_STYLES).map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
            <div className="col-span-2"><Input label="Options" k="options" placeholder="e.g. first rights, matching rights" /></div>
            <div className="col-span-2"><Textarea label="Back Signs" k="back_signs" placeholder="Back catalog tracks" rows={3} /></div>
            <Input label="Futures" k="futures" placeholder="e.g. 5 futures, album" />
            <div className="col-span-2"><Textarea label="Notes" k="notes" placeholder="Additional notes" /></div>
          </div>
        </div>
        {error && <p className="px-6 pb-2 text-sm text-red-500">{error}</p>}
        <div className="flex justify-end gap-2 px-6 pb-5">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors">Cancel</button>
          <button onClick={save} disabled={saving}
            className="px-5 py-2 bg-boom text-white text-sm font-medium rounded-lg hover:bg-boom/90 disabled:opacity-50 transition-colors">
            {saving ? 'Saving…' : isEdit ? 'Save' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ArtistRow({ item, onEdit, onDelete, onStatusChange }) {
  const [open, setOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const handleDelete = async (e) => {
    e.stopPropagation()
    if (!window.confirm(`Remove ${item.artist_name}?`)) return
    setDeleting(true)
    try { await api.delete(`/pending-contracts/${item.id}`); onDelete(item.id) }
    catch (e) { setDeleting(false) }
  }

  const quickStatus = async (e, status) => {
    e.stopPropagation()
    try {
      const res = await api.put(`/pending-contracts/${item.id}`, { ...item, status })
      if (res.data.success) onStatusChange(res.data.data)
    } catch (e) {}
  }

  return (
    <div className={`border border-divider rounded-xl overflow-hidden transition-all ${open ? 'shadow-sm' : 'hover:border-rule'}`}>
      {/* Main row */}
      <div
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-4 px-5 py-4 cursor-pointer transition-colors ${open ? 'bg-gray-50/80' : 'bg-card hover:bg-gray-50/50'}`}
      >
        {/* Chevron */}
        <ChevronDown className={`w-4 h-4 text-gray-300 shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />

        {/* Artist */}
        <div className="w-44 shrink-0">
          <p className="font-medium text-gray-900 text-sm leading-tight">{item.artist_name}</p>
          {item.legal_name && <p className="text-xs text-gray-400 mt-0.5 truncate">{item.legal_name}</p>}
        </div>

        {/* Deal terms as pills */}
        <div className="flex flex-wrap gap-1.5 flex-1 min-w-0">
          {item.split && <span className="px-2 py-0.5 bg-slate-100 text-slate-600 text-xs rounded-md font-medium">{item.split}</span>}
          {item.years && <span className="px-2 py-0.5 bg-rose-50 text-rose-700 text-xs rounded-md font-medium">{item.years}</span>}
          {item.futures && <span className="px-2 py-0.5 bg-sky-50 text-sky-700 text-xs rounded-md font-medium">{item.futures}</span>}
          {item.cash && <span className="px-2 py-0.5 bg-emerald-50 text-emerald-700 text-xs rounded-md font-medium">{item.cash}</span>}
        </div>

        {/* Status + actions */}
        <div className="flex items-center gap-3 ml-auto shrink-0">
          <StatusBadge status={item.status} />
          <button onClick={e => { e.stopPropagation(); onEdit(item) }}
            className="p-1.5 rounded-lg text-gray-300 hover:text-gray-600 hover:bg-gray-100 transition-colors">
            <Edit3 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Expanded detail */}
      {open && (
        <div className="px-5 py-5 border-t border-divider bg-card">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-x-8 gap-y-5 mb-5">
            <Field label="Options"    value={item.options} />
            <Field label="Futures"    value={item.futures} />
            <Field label="Email"      value={item.email} />
            <Field label="Back Signs" value={item.back_signs} wide />
            <Field label="Address"    value={item.address} />
            {item.notes && <Field label="Notes" value={item.notes} wide />}
          </div>

          <div className="flex items-center justify-between pt-4 border-t border-divider">
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400">Move to:</span>
              {Object.keys(STATUS_STYLES).filter(s => s !== item.status).map(s => (
                <button key={s} onClick={e => quickStatus(e, s)}
                  className="px-3 py-1 text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 rounded-full transition-colors font-medium">
                  {s}
                </button>
              ))}
            </div>
            <button onClick={handleDelete} disabled={deleting}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50">
              <Trash2 className="w-3.5 h-3.5" /> Remove
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function PendingContracts() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState('All')
  const [showAdd, setShowAdd] = useState(false)
  const [editItem, setEditItem] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.get('/pending-contracts')
      if (res.data.success) setItems(res.data.data)
    } catch (e) { console.error(e) }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const filtered = items.filter(item => {
    const q = search.toLowerCase()
    const matchSearch = !search ||
      item.artist_name?.toLowerCase().includes(q) ||
      item.legal_name?.toLowerCase().includes(q) ||
      item.email?.toLowerCase().includes(q) ||
      item.back_signs?.toLowerCase().includes(q)
    const matchStatus = filterStatus === 'All' || item.status === filterStatus
    return matchSearch && matchStatus
  })

  const counts = {
    All:        items.length,
    Sent:       items.filter(i => i.status === 'Sent').length,
    'Not Sent': items.filter(i => i.status === 'Not Sent').length,
    Signed:     items.filter(i => i.status === 'Signed').length,
    Declined:   items.filter(i => i.status === 'Declined').length,
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      {/* Header */}
      <PageHeader
        title="Pending Contracts"
        subtitle={`${items.length} artists in pipeline`}
        actions={<>
          <button onClick={load} className="p-2 rounded-lg border border-rule hover:bg-gray-50 text-gray-400 transition-colors">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button onClick={() => setShowAdd(true)}
            className="flex items-center gap-2 px-4 py-2 bg-boom text-white text-sm font-medium rounded-lg hover:bg-boom/90 transition-colors">
            <Plus className="w-4 h-4" /> Add Artist
          </button>
        </>}
      />

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3 mb-8">
        {[
          { label: 'Total',     value: counts.All,         color: 'text-gray-900'    },
          { label: 'Sent',      value: counts.Sent,        color: 'text-emerald-600' },
          { label: 'Not Sent',  value: counts['Not Sent'], color: 'text-amber-500'   },
          { label: 'Signed',    value: counts.Signed,      color: 'text-blue-600'    },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-card rounded-xl border border-divider p-4">
            <p className="text-xs text-gray-400 font-medium mb-1">{label}</p>
            <p className={`text-3xl font-bold ${color}`}>{value}</p>
          </div>
        ))}
      </div>

      {/* Search + filter */}
      <div className="flex gap-3 mb-5">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-300" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search artists, back signs, email…"
            className="w-full pl-9 pr-4 py-2.5 border border-rule rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-boom/20 focus:border-boom transition-all" />
        </div>
        <div className="flex bg-gray-100 rounded-xl p-1 gap-1">
          {Object.entries(counts).map(([s, c]) => (
            <button key={s} onClick={() => setFilterStatus(s)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all whitespace-nowrap ${
                filterStatus === s ? 'bg-card text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}>
              {s} <span className="ml-0.5 opacity-60">{c}</span>
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center py-24 text-gray-300">
          <RefreshCw className="w-5 h-5 animate-spin mr-2" /> Loading…
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No pending contracts"
          body="Contracts out for signature show here. They come from a deal marked Signed, or from the Contract generator."
          action={{ label: 'Create contract', to: '/contracts/create' }}
          source={{ label: 'Deals', to: '/deals' }}
        />
      ) : (
        <div className="space-y-2">
          {filtered.map(item => (
            <ArtistRow
              key={item.id}
              item={item}
              onEdit={setEditItem}
              onDelete={(id) => setItems(prev => prev.filter(i => i.id !== id))}
              onStatusChange={(updated) => setItems(prev => prev.map(i => i.id === updated.id ? updated : i))}
            />
          ))}
        </div>
      )}

      <p className="text-xs text-gray-300 mt-4">{filtered.length} of {items.length} artists</p>

      {showAdd && (
        <ContractModal item={null} onClose={() => setShowAdd(false)}
          onSaved={(item) => { setItems(prev => [item, ...prev]); setShowAdd(false) }} />
      )}
      {editItem && (
        <ContractModal item={editItem} onClose={() => setEditItem(null)}
          onSaved={(updated) => {
            setItems(prev => prev.map(i => i.id === updated.id ? updated : i))
            setEditItem(null)
          }} />
      )}
    </div>
  )
}
