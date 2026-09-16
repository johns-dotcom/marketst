import { useState, useEffect, useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft, ChevronRight, ChevronDown, Music2, Loader, CalendarClock,
  ExternalLink, X,
} from 'lucide-react'
import api from '../api'
import PageHeader from '../components/PageHeader'
import Skeleton from '../components/Skeleton'
import { formatDate, totalsToUsd, fmtMoney } from '../utils'
import { useFxRates } from '../context/FxRatesContext'

// 2025 Expenses — the prior-year bucket. Items get tagged from the
// Recoupments page (per item or per release); this subpage shows the
// whole bucket organized as artist key cards → per-artist drill-down
// grouped by song. URL-backed (?artist=) so a drill can be linked.

function fmt(v, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD', minimumFractionDigits: 2 }).format(Number(v) || 0)
}
function sumByCurrency(list) {
  const map = {}
  for (const e of list) {
    const c = (e.currency || 'USD').toUpperCase()
    map[c] = (map[c] || 0) + (Number(e.amount) || 0)
  }
  return map
}
function fmtTotals(totals) {
  return Object.entries(totals).map(([c, v]) => fmt(v, c)).join(' + ')
}

export default function Recoupments2025() {
  const [entries, setEntries] = useState(null)
  const { rates: fxRates } = useFxRates()
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedArtist = (searchParams.get('artist') || '').trim().toLowerCase() || null
  const setSelectedArtist = (key) => setSearchParams(key ? { artist: key } : {}, { replace: true })
  const [collapsedSongs, setCollapsedSongs] = useState(() => new Set())

  const fetchEntries = async () => {
    try {
      const res = await api.get('/bk/entries', { params: { status: 'approved', deleted: 'false' } })
      setEntries((res.data?.data || []).filter(e => e.is_2025_expense && !e.voided))
    } catch { setEntries([]) }
  }
  useEffect(() => { fetchEntries() }, [])

  // Artist key cards — best-spelling display name, totals, item count.
  const artistGroups = useMemo(() => {
    const by = new Map()
    for (const e of entries || []) {
      const key = (e.artist || '').trim().toLowerCase() || '__noartist__'
      if (!by.has(key)) by.set(key, { key, items: [], spellings: {} })
      const b = by.get(key)
      b.items.push(e)
      const raw = (e.artist || '').trim() || '(no artist)'
      b.spellings[raw] = (b.spellings[raw] || 0) + 1
    }
    return [...by.values()]
      .map(b => ({
        key: b.key,
        name: Object.entries(b.spellings).sort((a, c) => c[1] - a[1])[0][0],
        items: b.items,
        totals: sumByCurrency(b.items),
      }))
      .sort((a, c) => (totalsToUsd(c.totals, fxRates) || 0) - (totalsToUsd(a.totals, fxRates) || 0))
  }, [entries, fxRates])

  const currentArtist = selectedArtist
    ? artistGroups.find(a => a.key === selectedArtist) || null
    : null

  // Drill-down: songs sorted by total desc, '(no song)' last.
  const songSections = useMemo(() => {
    if (!currentArtist) return []
    const by = new Map()
    for (const it of currentArtist.items) {
      const s = (it.song || '').trim() || '(no song)'
      if (!by.has(s)) by.set(s, [])
      by.get(s).push(it)
    }
    return [...by.entries()]
      .map(([song, items]) => ({
        song,
        items: items.sort((a, c) => (c.payment_date || c.invoice_date || '').localeCompare(a.payment_date || a.invoice_date || '')),
        totals: sumByCurrency(items),
      }))
      .sort((a, c) => {
        if (a.song === '(no song)') return 1
        if (c.song === '(no song)') return -1
        return (totalsToUsd(c.totals, fxRates) || 0) - (totalsToUsd(a.totals, fxRates) || 0)
      })
  }, [currentArtist, fxRates])

  // Unmark — removes the tag; the row falls out of this page and back
  // to plain Recoupments state.
  const unmark = async (entry) => {
    try {
      await api.put(`/bk/entries/${entry.id}`, { is_2025_expense: false })
      setEntries(prev => (prev || []).filter(e => e.id !== entry.id))
    } catch (err) {
      alert('Failed to unmark: ' + (err.response?.data?.error || err.message))
    }
  }

  const grandTotals = useMemo(() => sumByCurrency(entries || []), [entries])
  const grandUsd = totalsToUsd(grandTotals, fxRates)

  if (entries === null) {
    return (
      <div className="space-y-4">
        <Skeleton.PageHeader />
        <Skeleton.StatCards />
        <Skeleton.Table />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <Link
        to="/recoupments"
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-gray-600 hover:text-gray-900 bg-card border border-rule hover:border-gray-300"
      >
        <ArrowLeft size={13} /> Back to Recoupments
      </Link>
      <PageHeader
        title="2025 Expenses"
        subtitle="Prior-year spend tagged from the Recoupments page — kept in its own bucket so current recoupment work stays clean."
      />

      {/* Summary strip */}
      <div className="card px-5 py-4 flex items-baseline gap-6 flex-wrap">
        <div>
          <p className="text-[10px] uppercase tracking-wider font-semibold text-gray-400">Items</p>
          <p className="text-2xl font-black text-gray-900 tabular-nums mt-1">{entries.length}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider font-semibold text-gray-400">Artists</p>
          <p className="text-2xl font-black text-gray-900 tabular-nums mt-1">{artistGroups.length}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider font-semibold text-gray-400">Total</p>
          <p className={`font-black text-amber-700 tabular-nums mt-1 ${Object.keys(grandTotals).length > 1 ? 'text-base' : 'text-2xl'}`}>
            {entries.length ? fmtTotals(grandTotals) : <span className="text-gray-300 text-2xl">—</span>}
          </p>
        </div>
        {grandUsd != null && entries.length > 0 && (
          <div>
            <p className="text-[10px] uppercase tracking-wider font-semibold text-gray-400">Total (USD)</p>
            <p className="text-2xl font-black text-amber-700 tabular-nums mt-1">
              {Object.keys(grandTotals).length > 1 ? '≈ ' : ''}{fmtMoney(grandUsd, 'USD')}
            </p>
          </div>
        )}
      </div>

      {entries.length === 0 ? (
        <div className="card p-12 text-center">
          <CalendarClock size={24} className="mx-auto text-gray-300 mb-3" />
          <p className="text-sm text-gray-400">
            Nothing tagged yet — use the "2025" action on Recoupments items or song headers to move prior-year spend here.
          </p>
        </div>
      ) : !currentArtist ? (
        /* ── Artist key cards ── */
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {artistGroups.map(a => (
            <button
              key={a.key}
              onClick={() => setSelectedArtist(a.key)}
              className="card p-5 text-left flex items-center justify-between gap-4 hover:shadow-md hover:border-amber-200 transition-all group"
            >
              <div className="min-w-0">
                <p className="text-sm font-bold text-gray-900 truncate group-hover:text-amber-700 transition-colors">{a.name}</p>
                <p className="text-xs text-gray-400 mt-0.5">{a.items.length} item{a.items.length === 1 ? '' : 's'}</p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <div className="text-right">
                  <p className={`font-bold text-amber-700 tabular-nums ${Object.keys(a.totals).length > 1 ? 'text-xs' : 'text-sm'}`}>{fmtTotals(a.totals)}</p>
                  {totalsToUsd(a.totals, fxRates) != null && Object.keys(a.totals).length > 1 && (
                    <p className="text-[10px] text-gray-400 tabular-nums">≈ {fmtMoney(totalsToUsd(a.totals, fxRates), 'USD')}</p>
                  )}
                </div>
                <ChevronRight size={16} className="text-gray-300 group-hover:text-amber-500 transition-colors" />
              </div>
            </button>
          ))}
        </div>
      ) : (
        /* ── Artist drill-down: songs → items ── */
        <div className="space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={() => setSelectedArtist(null)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-gray-600 hover:text-gray-900 bg-card border border-rule hover:border-gray-300"
            >
              <ArrowLeft size={13} /> All artists
            </button>
            <span className="text-sm font-bold text-gray-900">{currentArtist.name}</span>
            <span className="text-xs text-gray-500 tabular-nums">
              {currentArtist.items.length} item{currentArtist.items.length === 1 ? '' : 's'} · {fmtTotals(currentArtist.totals)}
              {totalsToUsd(currentArtist.totals, fxRates) != null && Object.keys(currentArtist.totals).length > 1 && (
                <span className="text-gray-400"> (≈ {fmtMoney(totalsToUsd(currentArtist.totals, fxRates), 'USD')})</span>
              )}
            </span>
          </div>

          {songSections.map(sec => {
            const key = `${currentArtist.key}::${sec.song}`
            const collapsed = collapsedSongs.has(key)
            return (
              <div key={key} className="card overflow-hidden">
                <button
                  onClick={() => setCollapsedSongs(prev => {
                    const next = new Set(prev)
                    next.has(key) ? next.delete(key) : next.add(key)
                    return next
                  })}
                  className="w-full px-4 py-2.5 flex items-center gap-2 hover:bg-gray-50/60 text-left"
                >
                  {collapsed ? <ChevronRight size={13} className="text-gray-400" /> : <ChevronDown size={13} className="text-gray-400" />}
                  <Music2 size={12} className={sec.song === '(no song)' ? 'text-amber-500' : 'text-gray-400'} />
                  <span className={`text-xs font-bold ${sec.song === '(no song)' ? 'text-amber-600 italic' : 'text-gray-900'}`}>{sec.song}</span>
                  <span className="text-[10px] text-gray-400">({sec.items.length})</span>
                  <span className="ml-auto text-xs font-bold text-gray-700 tabular-nums">{fmtTotals(sec.totals)}</span>
                </button>
                {!collapsed && sec.items.map(it => (
                  <div key={it.id} className="px-4 py-2.5 border-t border-gray-50 flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <span className="text-xs font-bold text-gray-900 truncate max-w-[260px]">{it.payee || '—'}</span>
                        {it.invoice_number && <span className="text-[10px] text-gray-400">#{it.invoice_number}</span>}
                        {it.category && <span className="text-[10px] text-gray-400">· {it.category}</span>}
                      </div>
                      <p className="text-[11px] text-gray-500 mt-0.5 tabular-nums">
                        {it.payment_date ? `paid ${formatDate(it.payment_date)}` : (it.invoice_date ? formatDate(it.invoice_date) : '—')}
                      </p>
                    </div>
                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold ${
                      it.payment_status === 'Paid' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'
                    }`}>
                      {it.payment_status || 'Unpaid'}
                    </span>
                    <span className="text-sm font-bold text-gray-900 tabular-nums whitespace-nowrap">{fmt(it.amount, it.currency)}</span>
                    <Link
                      to={`/bk/ledger?focus=${it.id}`}
                      className="text-gray-400 hover:text-boom-600 p-1"
                      title="Open this row in the Ledger"
                    >
                      <ExternalLink size={13} />
                    </Link>
                    <button
                      onClick={() => unmark(it)}
                      className="text-gray-400 hover:text-rose-600 p-1"
                      title="Remove from 2025 Expenses (the row stays on the Recoupments page)"
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
