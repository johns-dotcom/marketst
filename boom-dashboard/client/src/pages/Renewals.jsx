import { useState, useEffect } from 'react'
import { Clock, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react'
import api from '../api'
import { formatDate, daysUntilLocal } from '../utils'
import PageHeader from '../components/PageHeader'
import EmptyState from '../components/EmptyState'

export default function Renewals() {
  const [renewals, setRenewals] = useState([])
  const [filterType, setFilterType] = useState('All')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    fetchRenewals()
  }, [])

  const fetchRenewals = async () => {
    try {
      setLoading(true)
      const response = await api.get('/contracts/renewals')
      setRenewals(response.data.data || [])
    } catch (err) {
      setError('Failed to load renewals')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  const getDaysUntilExpiration = (expirationDate) => {
    // Local-calendar diff — the UTC-midnight parse made a contract
    // expiring tomorrow read "2 days" for most of the day.
    return daysUntilLocal(expirationDate) ?? 0
  }

  const getStatusBadge = (expirationDate) => {
    const daysLeft = getDaysUntilExpiration(expirationDate)
    if (daysLeft < 0) return 'badge badge-gray'
    if (daysLeft < 30) return 'badge badge-red'
    if (daysLeft < 90) return 'badge badge-yellow'
    return 'badge badge-green'
  }

  const getStatusLabel = (expirationDate) => {
    const daysLeft = getDaysUntilExpiration(expirationDate)
    if (daysLeft < 0) return 'Expired'
    if (daysLeft < 30) return 'Expiring Soon'
    if (daysLeft < 90) return '90 Days'
    return 'Active'
  }

  const getDaysColor = (daysLeft) => {
    if (daysLeft < 0) return 'text-gray-400'
    if (daysLeft < 30) return 'text-red-600'
    if (daysLeft < 90) return 'text-amber-600'
    return 'text-emerald-600'
  }

  const filteredRenewals = renewals.filter(renewal => {
    if (filterType === 'All') return true
    if (filterType === 'Expiring Soon') return getDaysUntilExpiration(renewal.expiration_date) < 30 && getDaysUntilExpiration(renewal.expiration_date) >= 0
    if (filterType === 'Active') return getDaysUntilExpiration(renewal.expiration_date) >= 30
    if (filterType === 'Expired') return getDaysUntilExpiration(renewal.expiration_date) < 0
    return true
  })

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-boom-600 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-gray-500">Loading renewals...</p>
        </div>
      </div>
    )
  }

  const expiringSoon = renewals.filter(r => getDaysUntilExpiration(r.expiration_date) < 30 && getDaysUntilExpiration(r.expiration_date) >= 0).length
  const active = renewals.filter(r => getDaysUntilExpiration(r.expiration_date) >= 30).length
  const expired = renewals.filter(r => getDaysUntilExpiration(r.expiration_date) < 0).length

  const statCards = [
    { label: 'Total Contracts', value: renewals.length, icon: Clock, color: 'text-gray-600', bg: 'bg-gray-50' },
    { label: 'Expiring Soon', value: expiringSoon, icon: AlertTriangle, color: 'text-red-600', bg: 'bg-red-50' },
    { label: '90 Days', value: renewals.filter(r => { const d = getDaysUntilExpiration(r.expiration_date); return d >= 30 && d < 90 }).length, icon: Clock, color: 'text-amber-600', bg: 'bg-amber-50' },
    { label: 'Active', value: active, icon: CheckCircle2, color: 'text-emerald-600', bg: 'bg-emerald-50' },
  ]

  return (
    <div className="space-y-6">
      <PageHeader
        title="Contract Renewals"
        subtitle="Track your contract expiration dates"
      />

      {/* Quick Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map(({ label, value, icon: Icon, color, bg }) => (
          <div key={label} className="card px-5 py-4 flex items-center gap-4">
            <div className={`w-10 h-10 ${bg} rounded-lg flex items-center justify-center flex-shrink-0`}>
              <Icon size={20} className={color} strokeWidth={1.5} />
            </div>
            <div>
              <p className="text-sm text-gray-500 font-medium">{label}</p>
              <p className="text-2xl font-semibold text-gray-900 mt-0.5">{value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex gap-1.5 flex-wrap">
        {[
          { key: 'All', count: renewals.length },
          { key: 'Expiring Soon', count: expiringSoon },
          { key: 'Active', count: active },
          { key: 'Expired', count: expired },
        ].map(({ key, count }) => (
          <button
            key={key}
            onClick={() => setFilterType(key)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-150 ${
              filterType === key
                ? 'bg-gray-900 text-white'
                : 'bg-card border border-rule text-gray-600 hover:bg-gray-50'
            }`}
          >
            {key} ({count})
          </button>
        ))}
      </div>

      {error && <div className="text-sm text-red-600 text-center py-12">{error}</div>}

      {/* Renewals Table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-rule bg-surface-50">
                <th className="table-header">Artist</th>
                <th className="table-header">Type</th>
                <th className="table-header">Territory</th>
                <th className="table-header">Expires</th>
                <th className="table-header">Days Left</th>
                <th className="table-header">Royalty</th>
                <th className="table-header">Advance</th>
                <th className="table-header">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filteredRenewals.length === 0 ? (
                <tr>
                  <td colSpan="8" className="p-3">
                    <EmptyState compact
                      title="Nothing coming up for renewal"
                      body="Contracts with an expiration or option date appear here as the date approaches."
                      source={{ label: 'Contracts', to: '/contracts' }}
                    />
                  </td>
                </tr>
              ) : (
                filteredRenewals
                  .sort((a, b) => new Date(a.expiration_date) - new Date(b.expiration_date))
                  .map(renewal => {
                    const daysLeft = getDaysUntilExpiration(renewal.expiration_date)
                    return (
                      <tr key={renewal.id} className="hover:bg-surface-50 transition-colors">
                        <td className="table-cell font-medium text-gray-900">{renewal.artist_name}</td>
                        <td className="table-cell text-gray-500">{renewal.type}</td>
                        <td className="table-cell text-gray-500">{renewal.territory}</td>
                        <td className="table-cell text-gray-500">{formatDate(renewal.expiration_date)}</td>
                        <td className="table-cell">
                          <span className={`text-sm font-semibold tabular-nums ${getDaysColor(daysLeft)}`}>
                            {daysLeft < 0 ? 'Expired' : `${daysLeft}d`}
                          </span>
                        </td>
                        <td className="table-cell text-gray-700 font-medium">{renewal.royalty_split}%</td>
                        <td className="table-cell text-gray-500">${renewal.advance?.toLocaleString()}</td>
                        <td className="table-cell">
                          <span className={getStatusBadge(renewal.expiration_date)}>
                            {getStatusLabel(renewal.expiration_date)}
                          </span>
                        </td>
                      </tr>
                    )
                  })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
