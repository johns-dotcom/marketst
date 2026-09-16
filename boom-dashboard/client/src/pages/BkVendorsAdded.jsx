import { useState, useEffect, useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  ArrowLeft, AlertTriangle, Users, ExternalLink, Copy, ChevronRight,
  Sparkles, CircleDollarSign,
} from 'lucide-react'
import api from '../api'
import PageHeader from '../components/PageHeader'
import Skeleton from '../components/Skeleton'
import { formatDate, totalsToUsd } from '../utils'
import { useFxRates } from '../context/FxRatesContext'

// Added-expense vendors — the invoice-less side of the vendor world.
// Expenses created via the Recoupments / Artist Campaigns add modals
// have no invoice number, so nothing structural prevents double entry
// or a creator's total quietly climbing. This subpage:
//   - aggregates those payees (normalized so spelling variants collapse)
//   - flags likely duplicate entries (same payee + amount within 7 days)
//   - flags spelling-variant groups that want a vendor rename/merge
//   - color-codes per-vendor totals so runaway spend is visible

function fmt(v, cur = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD', minimumFractionDigits: 2 }).format(Number(v) || 0)
}
function fmtTotals(totals) {
  return Object.entries(totals || {}).map(([c, v]) => fmt(v, c)).join(' + ')
}

// Spend-level bands — deliberately simple fixed thresholds (USD-equivalent)
// so "adding up too high" is visible at a glance.
const bandFor = (usd) => {
  if (usd >= 5000) return { label: 'High', cls: 'bg-rose-100 text-rose-700 ring-1 ring-rose-200/60' }
  if (usd >= 1000) return { label: 'Watch', cls: 'bg-amber-100 text-amber-700 ring-1 ring-amber-200/60' }
  return { label: 'OK', cls: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/60' }
}

export default function BkVendorsAdded() {
  const [data, setData] = useState(null)
  const { rates: fxRates } = useFxRates()
  const navigate = useNavigate()

  useEffect(() => {
    api.get('/bk/vendors/added-expenses')
      .then(r => setData(r.data?.data || { vendors: [], dupePairs: [], nameVariants: [] }))
      .catch(() => setData({ vendors: [], dupePairs: [], nameVariants: [] }))
  }, [])

  const vendors = useMemo(() => {
    if (!data) return []
    return data.vendors
      .map(v => ({ ...v, usd: totalsToUsd(v.totals, fxRates) ?? Object.values(v.totals).reduce((s, n) => s + n, 0) }))
      .sort((a, b) => b.usd - a.usd)
  }, [data, fxRates])

  const grandUsd = useMemo(() => vendors.reduce((s, v) => s + (v.usd || 0), 0), [vendors])

  if (!data) {
    return (
      <div className="space-y-4">
        <Skeleton.PageHeader />
        <Skeleton.Table />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <Link
        to="/bk/vendors"
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-gray-600 hover:text-gray-900 bg-card border border-rule hover:border-gray-300"
      >
        <ArrowLeft size={13} /> All vendors
      </Link>
      <PageHeader
        title="Added-Expense Vendors"
        subtitle="Creators paid through the Recoupments / Artist Campaigns add modals — no invoices on file, so totals and duplicates are tracked here."
      />

      {/* Summary strip */}
      <div className="card px-5 py-4 flex items-baseline gap-6 flex-wrap">
        <div>
          <p className="text-[10px] uppercase tracking-wider font-semibold text-gray-400">Vendors</p>
          <p className="text-2xl font-black text-gray-900 tabular-nums mt-1">{vendors.length}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider font-semibold text-gray-400">Items</p>
          <p className="text-2xl font-black text-gray-900 tabular-nums mt-1">{vendors.reduce((s, v) => s + v.count, 0)}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider font-semibold text-gray-400">Total (≈ USD)</p>
          <p className="text-2xl font-black text-boom-700 tabular-nums mt-1">{fmt(grandUsd)}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider font-semibold text-gray-400">Possible duplicates</p>
          <p className={`text-2xl font-black tabular-nums mt-1 ${data.dupePairs.length ? 'text-amber-600' : 'text-emerald-600'}`}>
            {data.dupePairs.length}
          </p>
        </div>
      </div>

      {/* Duplicate-entry recommendations */}
      {data.dupePairs.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-4 py-3 flex items-center gap-2 bg-amber-50/60 border-b border-amber-100">
            <Copy size={13} className="text-amber-600" />
            <span className="text-sm font-bold text-amber-800">Possible duplicate entries</span>
            <span className="text-[11px] text-amber-700/70">same payee, same amount, within 7 days — review and delete one if it's a double entry</span>
          </div>
          {data.dupePairs.map((p, i) => (
            <div key={i} className="px-4 py-2.5 border-b border-gray-50 last:border-b-0 flex items-center gap-3 flex-wrap">
              <AlertTriangle size={13} className="text-amber-500 shrink-0" />
              <span className="text-xs font-bold text-gray-900">{p.payee}</span>
              <span className="text-xs font-bold text-amber-700 tabular-nums">{fmt(p.amount, p.currency)} × 2</span>
              <span className="text-[11px] text-gray-500">
                {formatDate(p.a.date)}{p.a.artist ? ` · ${p.a.artist}` : ''}{p.a.song ? ` · ${p.a.song}` : ''}
                <span className="text-gray-300 mx-1.5">vs</span>
                {formatDate(p.b.date)}{p.b.artist ? ` · ${p.b.artist}` : ''}{p.b.song ? ` · ${p.b.song}` : ''}
              </span>
              <span className="ml-auto inline-flex items-center gap-1">
                <Link to={`/bk/ledger?focus=${p.a.id}`} className="text-[11px] font-bold text-boom-600 hover:text-boom-700 inline-flex items-center gap-0.5">
                  <ExternalLink size={11} /> #{p.a.id}
                </Link>
                <Link to={`/bk/ledger?focus=${p.b.id}`} className="text-[11px] font-bold text-boom-600 hover:text-boom-700 inline-flex items-center gap-0.5">
                  <ExternalLink size={11} /> #{p.b.id}
                </Link>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Name-variant recommendations */}
      {data.nameVariants.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-4 py-3 flex items-center gap-2 bg-sky-50/60 border-b border-sky-100">
            <Users size={13} className="text-sky-600" />
            <span className="text-sm font-bold text-sky-800">Name variants — probably the same vendor</span>
            <span className="text-[11px] text-sky-700/70">open the vendor page and use Merge Vendor / rename to consolidate totals</span>
          </div>
          {data.nameVariants.map((g, i) => (
            <div key={i} className="px-4 py-2.5 border-b border-gray-50 last:border-b-0 flex items-center gap-2 flex-wrap">
              <span className="text-xs font-bold text-gray-900">{g.payee}</span>
              <span className="text-[11px] text-gray-400">appears as:</span>
              {g.spellings.map(s => (
                <Link
                  key={s}
                  to={`/bk/vendors/${encodeURIComponent(s)}`}
                  className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-gray-50 text-gray-700 ring-1 ring-gray-200/60 hover:bg-sky-50 hover:text-sky-700"
                  title={`Open the vendor page for "${s}"`}
                >
                  {s}
                </Link>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Vendor table */}
      {vendors.length === 0 ? (
        <div className="card p-12 text-center">
          <Sparkles size={22} className="mx-auto text-gray-300 mb-2" />
          <p className="text-sm text-gray-400">No added expenses on file yet.</p>
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50/60 text-[10px] uppercase tracking-wide text-gray-500">
              <tr>
                <th className="text-left px-4 py-2 font-bold">Vendor / creator</th>
                <th className="text-right px-3 py-2 font-bold">Items</th>
                <th className="text-left px-3 py-2 font-bold">Artists</th>
                <th className="text-left px-3 py-2 font-bold">Last activity</th>
                <th className="text-right px-3 py-2 font-bold">Total</th>
                <th className="text-right px-3 py-2 font-bold">≈ USD</th>
                <th className="text-left px-3 py-2 font-bold">Level</th>
                <th className="px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {vendors.map(v => {
                const band = bandFor(v.usd || 0)
                return (
                  <tr
                    key={v.key}
                    onClick={() => navigate(`/bk/vendors/${encodeURIComponent(v.payee)}`)}
                    className="border-t border-gray-50 hover:bg-gray-50/60 cursor-pointer"
                    title="Open this vendor's page"
                  >
                    <td className="px-4 py-2.5 font-bold text-gray-900">
                      {v.payee}
                      {v.spellings.length > 1 && (
                        <span className="ml-1.5 text-[10px] font-semibold text-sky-600" title={`Also appears as: ${v.spellings.join(', ')}`}>
                          +{v.spellings.length - 1} spelling{v.spellings.length === 2 ? '' : 's'}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-gray-700 font-semibold">{v.count}</td>
                    <td className="px-3 py-2.5 text-gray-500 truncate max-w-[220px]" title={v.artists.join(', ')}>
                      {v.artists.slice(0, 3).join(', ') || '—'}{v.artists.length > 3 ? ` +${v.artists.length - 3}` : ''}
                    </td>
                    <td className="px-3 py-2.5 text-gray-500 tabular-nums whitespace-nowrap">{v.last_date ? formatDate(v.last_date) : '—'}</td>
                    <td className="px-3 py-2.5 text-right font-bold text-gray-900 tabular-nums whitespace-nowrap">{fmtTotals(v.totals)}</td>
                    <td className="px-3 py-2.5 text-right font-bold text-boom-700 tabular-nums whitespace-nowrap">
                      <span className="inline-flex items-center gap-1"><CircleDollarSign size={11} className="text-gray-300" />{fmt(v.usd)}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold ${band.cls}`}>{band.label}</span>
                    </td>
                    <td className="px-2 py-2.5"><ChevronRight size={13} className="text-gray-300" /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[10px] text-gray-400">
        Levels: Watch ≥ $1,000 · High ≥ $5,000 (USD-equivalent). Duplicate detection matches identical amounts for the
        same payee within 7 days; spelling variants match after stripping case, spaces, and punctuation.
      </p>
    </div>
  )
}
