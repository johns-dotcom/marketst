import { useState, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Plus, Loader, Lock, CheckCircle2, FileText, ChevronRight, Search } from 'lucide-react'
import api from '../api'
import PageHeader from '../components/PageHeader'
import { fmtMoney } from '../utils'

// ── Budget index ───────────────────────────────────────────────────
// Lists every recording budget with rolled-up header stats. Rows link
// into the per-budget planning + costs-to-date detail page.
export default function Budget() {
  const [budgets, setBudgets] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [creating, setCreating] = useState(false)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')  // '' | draft | approved | locked
  const navigate = useNavigate()

  const refetch = () => {
    setLoading(true)
    api.get('/budgets')
      .then(r => { setBudgets(r.data?.data || []); setError(null) })
      .catch(err => setError(err?.response?.data?.error || err.message || 'Failed to load'))
      .finally(() => setLoading(false))
  }
  useEffect(refetch, [])

  const create = async () => {
    if (creating) return
    setCreating(true)
    try {
      const r = await api.post('/budgets', {
        artist_name: '', project_title: '', type: 'budget', currency: 'USD',
      })
      const id = r.data?.data?.id
      if (id) navigate(`/budget/${id}`)
    } catch (err) {
      alert(`Failed to create budget: ${err?.response?.data?.error || err.message}`)
    } finally {
      setCreating(false)
    }
  }

  const filtered = budgets.filter(b => {
    if (statusFilter && b.status !== statusFilter) return false
    if (!search.trim()) return true
    const q = search.trim().toLowerCase()
    return (
      (b.artist_display || '').toLowerCase().includes(q) ||
      (b.project_title || '').toLowerCase().includes(q)
    )
  })

  // Roll-ups across visible budgets.
  const totals = filtered.reduce((acc, b) => ({
    total_budget: acc.total_budget + (Number(b.total_budget) || 0),
    advance:      acc.advance      + (Number(b.advance_amount) || 0),
    fund:         acc.fund         + (Number(b.fund_amount) || 0),
    approved: acc.approved + (b.status === 'approved' ? 1 : 0),
    locked:   acc.locked   + (b.status === 'locked' ? 1 : 0),
    draft:    acc.draft    + (b.status === 'draft' ? 1 : 0),
  }), { total_budget: 0, advance: 0, fund: 0, approved: 0, locked: 0, draft: 0 })

  return (
    <div className="space-y-6">
      <PageHeader tour="recording-budgets-header"
        title="Recording Budgets"
        subtitle="Draft, approve, and track recording budgets against actual spend. Modeled on the label's Recording Budget + Fund + Costs-to-Date templates."
        actions={
          <button
            type="button"
            onClick={create}
            disabled={creating}
            className="btn-primary text-xs gap-1.5 inline-flex items-center"
          >
            {creating ? <Loader size={13} className="animate-spin" /> : <Plus size={13} />}
            {creating ? 'Creating…' : 'New budget'}
          </button>
        }
      />

      {/* Summary strip */}
      {budgets.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div className="card p-4">
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Total budgeted</p>
            <p className="text-lg font-bold text-gray-900 tabular-nums mt-1">{fmtMoney(totals.total_budget)}</p>
            <p className="text-[10px] text-gray-400 mt-0.5">{filtered.length} budget{filtered.length === 1 ? '' : 's'} shown</p>
          </div>
          <div className="card p-4">
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Advances</p>
            <p className="text-lg font-bold text-gray-900 tabular-nums mt-1">{fmtMoney(totals.advance)}</p>
          </div>
          <div className="card p-4">
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Draft</p>
            <p className="text-lg font-bold text-gray-500 tabular-nums mt-1">{totals.draft}</p>
          </div>
          <div className="card p-4">
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Approved</p>
            <p className="text-lg font-bold text-emerald-700 tabular-nums mt-1">{totals.approved}</p>
          </div>
          <div className="card p-4">
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Locked</p>
            <p className="text-lg font-bold text-slate-700 tabular-nums mt-1">{totals.locked}</p>
          </div>
        </div>
      )}

      {/* Toolbar */}
      <div className="card px-4 py-3 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input data-tour="recording-budgets-search"
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search artist or project…"
            className="w-full pl-7 pr-2 py-1.5 text-xs rounded-md border border-rule bg-card focus:outline-none focus:ring-1 focus:ring-boom-500"
          />
        </div>
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="rounded-md border border-rule bg-card px-2 py-1.5 text-xs font-semibold text-gray-700"
        >
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="approved">Approved</option>
          <option value="locked">Locked</option>
        </select>
      </div>

      {/* List */}
      {loading ? (
        <div data-tour="recording-budgets-list" className="card p-12 flex items-center justify-center gap-2 text-sm text-gray-500">
          <Loader size={16} className="animate-spin" /> Loading budgets…
        </div>
      ) : error ? (
        <div className="card p-12 text-center text-sm text-rose-700">{error}</div>
      ) : filtered.length === 0 ? (
        <div className="card p-12 text-center text-sm text-gray-500">
          {budgets.length === 0 ? (
            <>
              <FileText size={24} className="mx-auto text-gray-300 mb-2" />
              No budgets yet. Click <span className="font-semibold">New budget</span> to start one.
            </>
          ) : 'No budgets match your filters.'}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(b => <BudgetRow key={b.id} b={b} />)}
        </div>
      )}
    </div>
  )
}

// ── BudgetRow ──────────────────────────────────────────────────────
function BudgetRow({ b }) {
  const statusTone = {
    draft:    { bg: 'bg-gray-100',    text: 'text-gray-700',    icon: null },
    approved: { bg: 'bg-emerald-100', text: 'text-emerald-800', icon: <CheckCircle2 size={11} /> },
    locked:   { bg: 'bg-slate-200',   text: 'text-slate-800',   icon: <Lock size={11} /> },
  }[b.status] || { bg: 'bg-gray-100', text: 'text-gray-700' }
  const typeTone = b.type === 'fund'
    ? 'bg-boom-50 text-boom-700 ring-1 ring-boom-200'
    : 'bg-sky-50 text-sky-700 ring-1 ring-sky-200'

  return (
    <Link
      to={`/budget/${b.id}`}
      className="card block hover:border-boom-200 hover:shadow-sm transition-all p-4"
    >
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-gray-900 truncate">
              {b.artist_display || <span className="text-gray-400 italic">Unnamed artist</span>}
            </span>
            <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${typeTone}`}>
              {b.type === 'fund' ? 'Fund' : 'Budget'}
            </span>
            <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${statusTone.bg} ${statusTone.text}`}>
              {statusTone.icon}
              {b.status}
            </span>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            {b.project_title || <span className="text-gray-400 italic">no project title</span>}
            {b.proposed_tracks ? <span className="text-gray-400"> · {b.proposed_tracks} track{b.proposed_tracks === 1 ? '' : 's'}</span> : null}
            <span className="text-gray-300 mx-2">·</span>
            {b.line_item_count} line item{b.line_item_count === 1 ? '' : 's'}
          </p>
        </div>
        <div className="flex items-center gap-4 flex-shrink-0">
          <div className="text-right">
            <p className="text-[10px] text-gray-400 uppercase tracking-wider font-semibold">Total</p>
            <p className="text-sm font-bold text-gray-900 tabular-nums">{fmtMoney(b.total_budget, b.currency)}</p>
          </div>
          {(Number(b.advance_amount) > 0 || (b.type === 'fund' && Number(b.fund_amount) > 0)) && (
            <div className="text-right">
              <p className="text-[10px] text-gray-400 uppercase tracking-wider font-semibold">
                {b.type === 'fund' ? 'Fund' : 'Advance'}
              </p>
              <p className="text-sm font-semibold text-gray-700 tabular-nums">
                {fmtMoney(b.type === 'fund' ? b.fund_amount : b.advance_amount, b.currency)}
              </p>
            </div>
          )}
          <ChevronRight size={16} className="text-gray-300" />
        </div>
      </div>
    </Link>
  )
}
