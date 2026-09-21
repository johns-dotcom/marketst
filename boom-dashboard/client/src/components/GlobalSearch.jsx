import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Search, Music, Users, FileText, TrendingUp, X, Clock, Command, Building2, Receipt, CornerDownRight } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import api from '../api'
import { formatDate } from '../utils'
import { NAV_PAGES } from '../navConfig'
import { scorePage, searchPages } from '../lib/pageSearch'
import { useAuth } from '../context/AuthContext'

function debounce(fn, ms) {
  let timer
  return (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
}

const CATEGORIES = [
  { id: 'all',       label: 'All' },
  { id: 'pages',     label: 'Pages',     icon: CornerDownRight },
  { id: 'vendors',   label: 'Vendors',   icon: Building2 },
  { id: 'entries',   label: 'Ledger',    icon: Receipt },
  { id: 'releases',  label: 'Releases',  icon: Music },
  { id: 'artists',   label: 'Artists',   icon: Users },
  { id: 'contracts', label: 'Contracts', icon: FileText },
  { id: 'deals',     label: 'Deals',     icon: TrendingUp },
]

function loadRecent() {
  try { return JSON.parse(localStorage.getItem('recent_searches') || '[]') } catch { return [] }
}
function saveRecent(list) {
  localStorage.setItem('recent_searches', JSON.stringify(list.slice(0, 8)))
}

export default function GlobalSearch() {
  const { canView } = useAuth()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('all')
  const [recent, setRecent] = useState(loadRecent)
  const containerRef = useRef(null)
  const inputRef = useRef(null)
  const navigate = useNavigate()

  // Debounced search
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const doSearch = useCallback(
    debounce(async (q) => {
      if (q.trim().length < 2) {
        setResults(null)
        setLoading(false)
        return
      }
      try {
        const res = await api.get('/search', { params: { q } })
        setResults(res.data.data)
      } catch {
        setResults(null)
      } finally {
        setLoading(false)
      }
    }, 300),
    []
  )

  useEffect(() => {
    if (query.trim().length >= 2) {
      setLoading(true)
      doSearch(query)
    } else {
      setResults(null)
      setLoading(false)
    }
  }, [query, doSearch])

  // Close on outside click
  useEffect(() => {
    const handler = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Cmd+K shortcut
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        setOpen(true)
      }
      // / shortcut — focus search (skip when in an input)
      if (e.key === '/' && !e.metaKey && !e.ctrlKey) {
        const tag = document.activeElement?.tagName?.toLowerCase()
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return
        if (document.querySelector('[data-tour-overlay]')) return   // a tour owns the keyboard
        e.preventDefault()
        inputRef.current?.focus()
        setOpen(true)
      }
      if (e.key === 'Escape' && open) {
        setOpen(false)
        inputRef.current?.blur()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open])

  // Matching pages — local, instant, and gated by canView so the palette never
  // offers a destination that App.jsx would bounce straight back to '/'.
  const pageHits = useMemo(
    () => searchPages(NAV_PAGES, query, canView),
    [query, canView]
  )

  // Filter results by category
  const filteredResults = results ? {
    releases:  filter === 'all' || filter === 'releases'  ? results.releases  : [],
    artists:   filter === 'all' || filter === 'artists'   ? results.artists   : [],
    contracts: filter === 'all' || filter === 'contracts' ? results.contracts : [],
    deals:     filter === 'all' || filter === 'deals'     ? results.deals     : [],
    vendors:   filter === 'all' || filter === 'vendors'   ? (results.vendors || []) : [],
    entries:   filter === 'all' || filter === 'entries'   ? (results.entries || []) : [],
  } : null

  const shownPages = (filter === 'all' || filter === 'pages') ? pageHits : []

  // Pages resolve locally, so they count even while the server half is still in
  // flight — otherwise typing "vendors" flashes "No results" for 300ms on a
  // query that was answerable before the keystroke finished.
  const hasResults = shownPages.length > 0 || (filteredResults && (
    filteredResults.releases?.length ||
    filteredResults.artists?.length ||
    filteredResults.contracts?.length ||
    filteredResults.deals?.length ||
    filteredResults.vendors?.length ||
    filteredResults.entries?.length
  ))

  const handleSelect = (type, item) => {
    // Save to recent
    const label = type === 'release' ? item.project_name
      : type === 'artist' ? item.name
      : type === 'contract' ? `${item.artist_name} — ${item.type}`
      : type === 'page' ? item.label
      : type === 'vendor' ? item.payee
      : type === 'entry' ? (item.invoice_number || item.payee)
      : item.artist_name
    // `path` and `payee` ride along so a recent entry can navigate on its own.
    // Keying dedupe on id alone collapsed every page (all id undefined) into one
    // row — the key has to be whatever actually identifies that TYPE.
    const key = item.id ?? item.path ?? item.payee
    const newRecent = [{ type, label, id: item.id, path: item.path, payee: item.payee, invoice_number: item.invoice_number },
      ...recent.filter(r => !(r.type === type && (r.id ?? r.path ?? r.payee) === key))].slice(0, 8)
    setRecent(newRecent)
    saveRecent(newRecent)

    setQuery('')
    setResults(null)
    setOpen(false)
    go(type, item)
  }

  // One place that turns a result into a destination, used by both a fresh hit
  // and a recent one — they used to be two copies and the second was already
  // missing types the first had.
  const go = (type, item) => {
    if (type === 'release') navigate(`/releases/${item.id}`)
    else if (type === 'artist') navigate(`/artists/${item.id}`)
    else if (type === 'contract') navigate('/contracts')
    else if (type === 'deal') navigate('/deals')
    else if (type === 'page') navigate(item.path)
    // The vendor page keys on the payee STRING, so it has to survive a slash or
    // an ampersand in a company name.
    else if (type === 'vendor') navigate(`/bk/vendors/${encodeURIComponent(item.payee)}`)
    // A ledger row has no page of its own; the Ledger's own search is where it
    // is editable, so hand the query over rather than inventing a detail route.
    else if (type === 'entry') navigate(`/bk/ledger?q=${encodeURIComponent(item.invoice_number || item.payee || '')}`)
  }

  const handleRecentClick = (item) => {
    setOpen(false)
    setQuery('')
    go(item.type, item)
  }

  const clearRecent = () => {
    setRecent([])
    saveRecent([])
  }

  const showDropdown = open
  const showResults = query.trim().length >= 2
  const showRecent = !showResults && recent.length > 0

  return (
    <div ref={containerRef} className="relative w-full max-w-md">
      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder="Search..."
          className="w-full pl-9 pr-20 py-2 text-sm bg-gray-50 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-boom-500/30 focus:border-boom-400 focus:bg-white transition-colors placeholder:text-gray-400"
          onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
        />
        <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
          {query ? (
            <button
              onClick={() => { setQuery(''); setResults(null); inputRef.current?.focus() }}
              className="text-gray-400 hover:text-gray-600"
            >
              <X size={14} />
            </button>
          ) : (
            <kbd className="text-[10px] font-mono text-gray-400 bg-gray-100 border border-gray-200 rounded px-1.5 py-0.5 hidden sm:inline-flex items-center gap-0.5">
              <Command size={10} />K
            </kbd>
          )}
        </div>
      </div>

      {/* Dropdown */}
      {showDropdown && (
        <div className="absolute top-full left-0 right-0 mt-1.5 bg-white rounded-xl shadow-lg border border-gray-200 z-50 overflow-hidden max-h-[480px] overflow-y-auto">

          {/* Category filter pills */}
          {showResults && (
            <div className="flex items-center gap-1 px-3 py-2 border-b border-gray-100">
              {CATEGORIES.map(cat => (
                <button
                  key={cat.id}
                  onMouseDown={(e) => { e.preventDefault(); setFilter(cat.id) }}
                  className={`text-[10px] font-semibold px-2 py-1 rounded-md transition-colors ${
                    filter === cat.id ? 'bg-boom-600 text-white' : 'text-gray-500 hover:bg-gray-100'
                  }`}
                >
                  {cat.label}
                </button>
              ))}
            </div>
          )}

          {/* Recent searches */}
          {showRecent && (
            <div>
              <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
                <div className="flex items-center gap-1.5">
                  <Clock size={11} className="text-gray-400" />
                  <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Recent</span>
                </div>
                <button onMouseDown={clearRecent} className="text-[10px] text-gray-400 hover:text-gray-600 font-semibold">Clear</button>
              </div>
              {recent.map((item, i) => (
                <button
                  key={i}
                  onMouseDown={() => handleRecentClick(item)}
                  className="w-full text-left flex items-center gap-2.5 px-3 py-2 hover:bg-boom-50 transition-colors"
                >
                  <Clock size={12} className="text-gray-300 flex-shrink-0" />
                  <span className="text-sm text-gray-600">{item.label}</span>
                  <span className="text-[10px] text-gray-400 ml-auto">{item.type}</span>
                </button>
              ))}
            </div>
          )}

          {/* Loading — the SERVER half only. Pages have already rendered above. */}
          {showResults && loading && (
            <div className="px-4 py-3 text-sm text-gray-400 flex items-center gap-2">
              <div className="w-3.5 h-3.5 border-2 border-boom-500 border-t-transparent rounded-full animate-spin" />
              Searching…
            </div>
          )}

          {/* No results — only once the server half has settled too. */}
          {showResults && !loading && !hasResults && (
            <div className="px-4 py-3 text-sm text-gray-400">No results for "{query}"</div>
          )}

          {/* Results */}
          {showResults && hasResults && (
            <div className="py-1">
              {/* Pages — first, and rendered even while the server half is in
                  flight, because they are the fastest answer the palette has
                  and the one most often wanted. */}
              {shownPages.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1">
                    <CornerDownRight size={11} className="text-gray-400" />
                    <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Pages</span>
                  </div>
                  {shownPages.map((pg) => (
                    <button
                      key={pg.path}
                      onMouseDown={() => handleSelect('page', pg)}
                      className="w-full text-left flex items-center gap-2.5 px-3 py-2 hover:bg-boom-50 transition-colors"
                    >
                      <CornerDownRight size={12} className="text-gray-300 flex-shrink-0" />
                      <span className="text-sm text-gray-800 font-medium">{pg.label}</span>
                      <span className="text-[10px] text-gray-400 ml-auto">{pg.group}</span>
                    </button>
                  ))}
                </div>
              )}

              {/* Vendors */}
              {filteredResults?.vendors?.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1">
                    <Building2 size={11} className="text-gray-400" />
                    <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Vendors</span>
                  </div>
                  {filteredResults.vendors.map((v) => (
                    <button
                      key={v.payee}
                      onMouseDown={() => handleSelect('vendor', v)}
                      className="w-full text-left flex items-center gap-2.5 px-3 py-2 hover:bg-boom-50 transition-colors"
                    >
                      <Building2 size={12} className="text-gray-300 flex-shrink-0" />
                      <span className="text-sm text-gray-800 truncate">{v.payee}</span>
                      <span className="text-[10px] text-gray-400 ml-auto flex-shrink-0">
                        {v.invoice_count} invoice{v.invoice_count === 1 ? '' : 's'}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {/* Ledger entries */}
              {filteredResults?.entries?.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1">
                    <Receipt size={11} className="text-gray-400" />
                    <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Ledger</span>
                  </div>
                  {filteredResults.entries.map((e) => (
                    <button
                      key={e.id}
                      onMouseDown={() => handleSelect('entry', e)}
                      className="w-full text-left flex items-center gap-2.5 px-3 py-2 hover:bg-boom-50 transition-colors"
                    >
                      <Receipt size={12} className="text-gray-300 flex-shrink-0" />
                      <span className="text-sm text-gray-800 truncate">
                        {e.invoice_number ? `#${e.invoice_number} · ` : ''}{e.payee}
                      </span>
                      <span className="text-[10px] text-gray-400 ml-auto flex-shrink-0">
                        {e.invoice_date ? formatDate(e.invoice_date) : ''}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {/* Releases */}
              {filteredResults.releases?.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1">
                    <Music size={11} className="text-gray-400" />
                    <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Releases</span>
                    <span className="text-[10px] text-gray-300">{filteredResults.releases.length}</span>
                  </div>
                  {filteredResults.releases.map(r => (
                    <button
                      key={r.id}
                      onMouseDown={() => handleSelect('release', r)}
                      className="w-full text-left flex items-center justify-between px-3 py-2 hover:bg-boom-50 transition-colors"
                    >
                      <div>
                        <span className="text-sm font-medium text-gray-900">{r.project_name}</span>
                        <span className="text-xs text-gray-500 ml-2">{r.artist_name}</span>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0 ml-3">
                        {r.release_type && (
                          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">{r.release_type}</span>
                        )}
                        <span className="text-xs text-gray-400">{formatDate(r.release_date)}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {/* Artists */}
              {filteredResults.artists?.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1">
                    <Users size={11} className="text-gray-400" />
                    <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Artists</span>
                    <span className="text-[10px] text-gray-300">{filteredResults.artists.length}</span>
                  </div>
                  {filteredResults.artists.map(a => (
                    <button
                      key={a.id}
                      onMouseDown={() => handleSelect('artist', a)}
                      className="w-full text-left flex items-center justify-between px-3 py-2 hover:bg-boom-50 transition-colors"
                    >
                      <div className="flex items-center gap-2.5">
                        <div className="w-6 h-6 rounded-full bg-boom-100 flex items-center justify-center flex-shrink-0">
                          <span className="text-[10px] font-bold text-boom-700">{a.name?.charAt(0)?.toUpperCase()}</span>
                        </div>
                        <span className="text-sm font-medium text-gray-900">{a.name}</span>
                      </div>
                      <span className="text-xs text-gray-400">{a.total_releases} releases</span>
                    </button>
                  ))}
                </div>
              )}

              {/* Contracts */}
              {filteredResults.contracts?.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1">
                    <FileText size={11} className="text-gray-400" />
                    <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Contracts</span>
                    <span className="text-[10px] text-gray-300">{filteredResults.contracts.length}</span>
                  </div>
                  {filteredResults.contracts.map(c => (
                    <button
                      key={c.id}
                      onMouseDown={() => handleSelect('contract', c)}
                      className="w-full text-left flex items-center justify-between px-3 py-2 hover:bg-boom-50 transition-colors"
                    >
                      <div>
                        <span className="text-sm font-medium text-gray-900">{c.artist_name}</span>
                        <span className="text-xs text-gray-500 ml-2">{c.type}</span>
                      </div>
                      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                        c.status === 'Active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                      }`}>{c.status}</span>
                    </button>
                  ))}
                </div>
              )}

              {/* Deals */}
              {filteredResults.deals?.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1">
                    <TrendingUp size={11} className="text-gray-400" />
                    <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Deals</span>
                    <span className="text-[10px] text-gray-300">{filteredResults.deals.length}</span>
                  </div>
                  {filteredResults.deals.map(d => (
                    <button
                      key={d.id}
                      onMouseDown={() => handleSelect('deal', d)}
                      className="w-full text-left flex items-center justify-between px-3 py-2 hover:bg-boom-50 transition-colors"
                    >
                      <div>
                        <span className="text-sm font-medium text-gray-900">{d.artist_name}</span>
                        {d.genre && <span className="text-xs text-gray-500 ml-2">{d.genre}</span>}
                      </div>
                      <span className="text-xs text-gray-400">{d.stage}</span>
                    </button>
                  ))}
                </div>
              )}

              <div className="h-1" />
            </div>
          )}

          {/* Empty state when focused but no query */}
          {!showResults && !showRecent && (
            <div className="px-4 py-4 text-center">
              <p className="text-xs text-gray-400">Search releases, artists, contracts, and deals</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
