import { useState, useEffect } from 'react'
import { Loader, ChevronLeft, ChevronRight, Check, X, Pencil, Plus, Trash2, Clock } from 'lucide-react'
import api from '../api'
import PageHeader from '../components/PageHeader'
import Skeleton from '../components/Skeleton'
import { useAuth } from '../context/AuthContext'

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

function fmt(v) {
  if (!v && v !== 0) return ''
  return Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function Salary() {
  const { user } = useAuth()
  const role = user?.role?.toLowerCase()
  const isAdmin = role === 'admin' || role === 'superadmin'

  // NOTE: the admin gate lives BELOW the hook block (see after the last
  // useState). An early return up here changes the hook count whenever the
  // role flips mid-session (auth hydration, impersonation) and crashes the
  // page with "Rendered more hooks than during the previous render".
  const now = new Date()
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [year, setYear] = useState(now.getFullYear())
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(null)
  const [editingId, setEditingId] = useState(null)
  const [editForm, setEditForm] = useState({ name: '', department: '', monthly_amount: '' })
  const [showAddForm, setShowAddForm] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [history, setHistory] = useState([])
  const [addForm, setAddForm] = useState({ name: '', department: '', monthly_amount: '' })

  const fetchData = async () => {
    if (!isAdmin) { setLoading(false); return }
    try {
      setLoading(true)
      const res = await api.get('/salary', { params: { month, year } })
      setEntries(res.data.data || [])
    } catch (err) {
      console.error('Failed to load salary data:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchData() }, [month, year])

  const fetchHistory = async () => {
    try {
      const res = await api.get('/salary/history', { params: { month, year } })
      setHistory(res.data.data || [])
    } catch { setHistory([]) }
  }

  const toggleHistory = () => {
    if (!showHistory) fetchHistory()
    setShowHistory(v => !v)
  }

  const togglePaid = async (userId, currentPaid) => {
    setSaving(userId)
    try {
      await api.put(`/salary/${userId}`, { month, year, paid: !currentPaid })
      setEntries(prev => prev.map(e =>
        e.id === userId ? { ...e, paid: !currentPaid, paid_at: !currentPaid ? new Date().toISOString() : null } : e
      ))
    } catch (err) {
      console.error('Failed to update:', err)
    } finally {
      setSaving(null)
    }
  }

  const prevMonth = () => {
    if (month === 1) { setMonth(12); setYear(y => y - 1) }
    else setMonth(m => m - 1)
  }
  const nextMonth = () => {
    if (month === 12) { setMonth(1); setYear(y => y + 1) }
    else setMonth(m => m + 1)
  }

  const startEdit = (member) => {
    setEditingId(member.id)
    setEditForm({ name: member.name, department: member.department || '', monthly_amount: String(member.monthly_amount || '') })
  }

  const [saveError, setSaveError] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)

  // Admin gate — after every hook above so the hook count is stable
  // across renders regardless of role.
  if (!isAdmin) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-sm text-gray-400">Admin access required</p>
      </div>
    )
  }

  const saveEdit = async () => {
    if (!editingId || savingEdit) return
    setSaveError('')
    setSavingEdit(true)
    try {
      const amount = parseFloat(editForm.monthly_amount)
      const res = await api.put(`/salary/employees/${editingId}`, {
        name: (editForm.name || '').trim(),
        department: (editForm.department || '').trim(),
        monthly_amount: Number.isFinite(amount) ? amount : 0,
      })
      // Trust the server's row over our optimistic guess so a half-saved or
      // mocked write doesn't drift the UI from the DB.
      const serverRow = res?.data?.data
      setEntries(prev => prev.map(e => {
        if (e.id !== editingId) return e
        if (serverRow && serverRow.id === editingId) {
          // Preserve paid/paid_at/paid_amount/paid_by/notes from current row —
          // the PUT only returns the salary_employees columns, not the join.
          return { ...e, name: serverRow.name, department: serverRow.department, monthly_amount: serverRow.monthly_amount }
        }
        return { ...e, name: editForm.name, department: editForm.department, monthly_amount: Number.isFinite(amount) ? amount : 0 }
      }))
      setEditingId(null)
    } catch (err) {
      console.error('Failed to save:', err)
      setSaveError(err.response?.data?.error || err.message || 'Failed to save')
    } finally {
      setSavingEdit(false)
    }
  }

  const handleAdd = async () => {
    if (!addForm.name) return
    try {
      await api.post('/salary/employees', {
        name: addForm.name,
        department: addForm.department,
        monthly_amount: parseFloat(addForm.monthly_amount) || 0,
      })
      setAddForm({ name: '', department: '', monthly_amount: '' })
      setShowAddForm(false)
      fetchData()
    } catch (err) { console.error('Failed to add:', err) }
  }

  const handleRemove = async (id, name) => {
    if (!window.confirm(`Remove ${name} from payroll?`)) return
    try {
      await api.delete(`/salary/employees/${id}`)
      setEntries(prev => prev.filter(e => e.id !== id))
    } catch (err) { console.error('Failed to remove:', err) }
  }

  const paidCount = entries.filter(e => e.paid).length
  const totalCount = entries.length
  const totalPayroll = entries.reduce((s, e) => s + parseFloat(e.monthly_amount || 0), 0)
  const paidPayroll = entries.filter(e => e.paid).reduce((s, e) => s + parseFloat(e.monthly_amount || 0), 0)

  // Group by department
  const departments = {}
  entries.forEach(e => {
    const dept = e.department || 'Other'
    if (!departments[dept]) departments[dept] = []
    departments[dept].push(e)
  })

  return (
    <div className="space-y-6">
      {saveError && (
        <div className="flex items-center justify-between bg-red-50 border border-red-200 rounded-lg px-4 py-2 text-sm text-red-700">
          <span><strong>Save failed:</strong> {saveError}</span>
          <button onClick={() => setSaveError('')} className="text-red-500 hover:text-red-700 text-xs font-semibold">Dismiss</button>
        </div>
      )}
      <PageHeader tour="salary-header"
        title="Salary"
        subtitle="Track monthly employee payments"
        actions={
          <div className="flex items-center gap-3">
            <button onClick={prevMonth} className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors">
              <ChevronLeft size={18} className="text-gray-500" />
            </button>
            <span className="text-sm font-bold text-gray-900 min-w-[140px] text-center">
              {MONTHS[month - 1]} {year}
            </span>
            <button onClick={nextMonth} className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors">
              <ChevronRight size={18} className="text-gray-500" />
            </button>
            <button
              onClick={() => { setMonth(now.getMonth() + 1); setYear(now.getFullYear()) }}
              className="text-xs font-semibold text-gray-500 hover:text-gray-700 px-3 py-1.5 border border-rule rounded-lg hover:bg-gray-50 transition-colors"
            >
              This Month
            </button>
            <button
              onClick={toggleHistory}
              className={`text-xs font-semibold px-3 py-1.5 border rounded-lg transition-colors flex items-center gap-1.5 ${
                showHistory ? 'border-boom-400 text-boom-600 bg-boom-50' : 'border-rule text-gray-500 hover:text-gray-700 hover:bg-gray-50'
              }`}
            >
              <Clock size={13} /> History
            </button>
          </div>
        }
      />

      {/* Summary bar */}
      <div data-tour="salary-summary" className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="card px-4 py-3">
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">Total Payroll</p>
          <p className="text-xl font-black text-gray-900 mt-1">{fmt(totalPayroll)}</p>
        </div>
        <div className="card px-4 py-3">
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">Paid Out</p>
          <p className="text-xl font-black text-emerald-600 mt-1">{fmt(paidPayroll)}</p>
        </div>
        <div className="card px-4 py-3">
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">Remaining</p>
          <p className="text-xl font-black text-red-600 mt-1">{fmt(totalPayroll - paidPayroll)}</p>
        </div>
        <div className="card px-4 py-3">
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">Employees</p>
          <p className="text-xl font-black text-gray-900 mt-1">{paidCount} <span className="text-sm font-semibold text-gray-400">/ {totalCount} paid</span></p>
        </div>
      </div>

      {/* Payment history */}
      {showHistory && (
        <div className="card p-5">
          <h3 className="text-sm font-bold text-gray-900 mb-3">Payment History — {MONTHS[month - 1]} {year}</h3>
          {history.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-4">No history for this month</p>
          ) : (
            <div className="space-y-1.5">
              {history.map(h => (
                <div key={h.id} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
                  <div>
                    <span className="text-sm font-medium text-gray-900">{h.employee_name}</span>
                    <span className={`ml-2 text-xs font-bold px-1.5 py-0.5 rounded ${
                      h.action === 'marked_paid' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'
                    }`}>{h.action === 'marked_paid' ? 'Paid' : 'Unpaid'}</span>
                  </div>
                  <span className="text-xs text-gray-400">
                    {h.performed_by} · {new Date(h.performed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {loading ? (
        <div data-tour="salary-body" className="space-y-6">
          <Skeleton.StatCards count={4} />
          <Skeleton.Block h="h-48" />
          <Skeleton.Block h="h-48" />
        </div>
      ) : entries.length === 0 ? (
        <div className="card p-12 text-center">
          <p className="text-sm text-gray-400">No team members found</p>
        </div>
      ) : (
        <div className="space-y-4">
          {Object.entries(departments).map(([dept, members]) => (
            <div key={dept} className="card overflow-hidden">
              <div className="px-5 py-3 bg-gray-50 border-b border-divider flex items-center justify-between">
                <div>
                  <span className="text-xs font-bold text-gray-500 uppercase tracking-wide">{dept}</span>
                  <span className="text-xs text-gray-400 ml-2">
                    {members.filter(m => m.paid).length}/{members.length} paid
                  </span>
                </div>
                <span className="text-xs font-bold text-gray-500">
                  {fmt(members.reduce((s, m) => s + parseFloat(m.monthly_amount || 0), 0))}
                </span>
              </div>
              <div className="divide-y divide-gray-50">
                {members.map(member => (
                  <div key={member.id} className="flex items-center justify-between px-5 py-3 hover:bg-gray-50/50 transition-colors gap-3">
                    {editingId === member.id ? (
                      <>
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <input type="text" value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                            className="px-2 py-1 border border-gray-300 rounded-lg text-sm font-semibold w-32 focus:ring-2 focus:ring-boom-600 focus:border-transparent" />
                          <input type="text" value={editForm.department} onChange={e => setEditForm(f => ({ ...f, department: e.target.value }))}
                            placeholder="Dept" className="px-2 py-1 border border-gray-300 rounded-lg text-sm w-24 focus:ring-2 focus:ring-boom-600 focus:border-transparent" />
                          <div className="flex items-center gap-1">
                            <span className="text-sm text-gray-400">$</span>
                            <input type="number" step="1" value={editForm.monthly_amount} onChange={e => setEditForm(f => ({ ...f, monthly_amount: e.target.value }))}
                              className="px-2 py-1 border border-gray-300 rounded-lg text-sm font-bold w-24 text-right focus:ring-2 focus:ring-boom-600 focus:border-transparent" />
                          </div>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <button onClick={saveEdit} disabled={savingEdit} className="px-3 py-1.5 bg-gray-900 text-white text-xs font-bold rounded-lg hover:bg-gray-800 disabled:opacity-50">{savingEdit ? 'Saving…' : 'Save'}</button>
                          <button onClick={() => { setEditingId(null); setSaveError('') }} className="px-3 py-1.5 bg-gray-100 text-gray-600 text-xs font-bold rounded-lg hover:bg-gray-200">Cancel</button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold text-gray-900 truncate">{member.name}</p>
                          </div>
                          {member.monthly_amount > 0 && (
                            <span className="text-sm font-bold text-gray-900 tabular-nums flex-shrink-0">{fmt(member.monthly_amount)}</span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 flex-shrink-0">
                          {member.paid && member.paid_at && (
                            <span className="text-[11px] text-gray-400">
                              {new Date(member.paid_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                              {member.paid_by && <> by {member.paid_by}</>}
                            </span>
                          )}
                          <button
                            onClick={() => togglePaid(member.id, member.paid)}
                            disabled={saving === member.id}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                              member.paid
                                ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200'
                                : 'bg-red-50 text-red-600 hover:bg-red-100'
                            } ${saving === member.id ? 'opacity-50' : ''}`}
                          >
                            {saving === member.id ? (
                              <Loader size={12} className="animate-spin" />
                            ) : member.paid ? (
                              <Check size={12} />
                            ) : (
                              <X size={12} />
                            )}
                            {member.paid ? 'Paid' : 'Unpaid'}
                          </button>
                          <button onClick={() => startEdit(member)} className="p-1.5 text-gray-300 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors">
                            <Pencil size={13} />
                          </button>
                          <button onClick={() => handleRemove(member.id, member.name)} className="p-1.5 text-gray-300 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors">
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        {/* Add employee */}
          {showAddForm ? (
            <div className="card p-5">
              <p className="text-sm font-semibold text-gray-900 mb-3">Add Employee</p>
              <div className="flex items-center gap-2">
                <input type="text" value={addForm.name} onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Name" className="px-3 py-2 border border-gray-300 rounded-lg text-sm flex-1 focus:ring-2 focus:ring-boom-600 focus:border-transparent" />
                <input type="text" value={addForm.department} onChange={e => setAddForm(f => ({ ...f, department: e.target.value }))}
                  placeholder="Department" className="px-3 py-2 border border-gray-300 rounded-lg text-sm w-32 focus:ring-2 focus:ring-boom-600 focus:border-transparent" />
                <div className="flex items-center gap-1">
                  <span className="text-sm text-gray-400">$</span>
                  <input type="number" step="1" value={addForm.monthly_amount} onChange={e => setAddForm(f => ({ ...f, monthly_amount: e.target.value }))}
                    placeholder="Monthly" className="px-3 py-2 border border-gray-300 rounded-lg text-sm w-28 text-right focus:ring-2 focus:ring-boom-600 focus:border-transparent" />
                </div>
                <button onClick={handleAdd} className="px-4 py-2 bg-gray-900 text-white text-sm font-bold rounded-lg hover:bg-gray-800">Add</button>
                <button onClick={() => setShowAddForm(false)} className="px-4 py-2 bg-gray-100 text-gray-600 text-sm font-bold rounded-lg hover:bg-gray-200">Cancel</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setShowAddForm(true)}
              className="card w-full py-3 flex items-center justify-center gap-2 text-sm font-semibold text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-colors">
              <Plus size={16} /> Add Employee
            </button>
          )}
        </div>
      )}
    </div>
  )
}
