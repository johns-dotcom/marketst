import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Building2, Search, Zap, Link2, X, ExternalLink, GitMerge, Flag, ChevronDown, ChevronRight } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import api from '../api'
import BkVendorFlags from './BkVendorFlags'
import EmptyState from '../components/EmptyState'

// Unified Vendors directory — one row per COMPANY: ledger invoices + bank
// activity joined through explicit links, aliases, and name equality.
// Unlinked bank payees live in a finishable section at the bottom.
// Phase 1 of the vendors consolidation; detail pages are unchanged.

const fmt = (n) => `$${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtDay = (d) => {
  if (!d) return ''
  const [y, m, day] = String(d).slice(0, 10).split('-')
  return `${m}/${day}/${y}`
}

export default function BkVendorsUnified() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [vendors, setVendors] = useState([])
  const [unlinked, setUnlinked] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // Confirmation for a completed merge. Worth its own line rather than an
  // alert(): the useful part is WHAT moved, and a merge with 0 renamed entries
  // used to look identical to one that silently failed.
  const [notice, setNotice] = useState('')
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(''), 8000)
    return () => clearTimeout(t)
  }, [notice])
  const [q, setQ] = useState('')
  const [sortKey, setSortKey] = useState('relationship')
  const [sortDir, setSortDir] = useState('desc')
  const [unlinkedOpen, setUnlinkedOpen] = useState(false)
  // Each worklist is its own view now, not a chip on the directory. They are
  // different JOBS — chase an invoice, name an artist, attach a paid invoice to
  // its bank line — and as chips they shared one toolbar, one sort and one
  // header, so which question you were working on was a matter of remembering
  // which chip you had pressed.
  //
  // Kept in ?tab= rather than a path segment: vendor DETAIL is /bk/vendors/:name,
  // so a path would collide with a vendor actually called "needs-artist", and
  // page permissions are stored by path.
  const VIEWS = {
    directory: { label: 'Directory' },
    needs: {
      label: 'Needs matching', sort: 'needs', tone: 'rose',
      count: (v) => v.bank?.needs_n || 0, total: (v) => v.bank?.needs_total || 0,
      blurb: 'Payments with no invoice behind them, and no rule saying there never will be. Open a vendor to attach the invoice or say one is not coming.',
    },
    artist: {
      label: 'Needs artist', sort: 'needs_artist', tone: 'violet',
      count: (v) => v.bank?.needs_artist_n || 0, total: (v) => v.bank?.needs_artist_total || 0,
      blurb: 'Booked payments that name nobody. This is what leaves Spend by Artist reporting a quarter of actual spend — attribute them, or mark the vendor as overhead.',
    },
    attach: {
      label: 'To attach', sort: 'to_attach', tone: 'amber',
      count: (v) => v.to_attach || 0, total: (v) => v.to_attach_total || 0,
      blurb: 'Invoices marked Paid, with a statement covering that date on file, and no bank line attached. The pairing is one click on the vendor page.',
    },
    duplicates: { label: 'Duplicates' },
  }
  const [view, setView] = useState(() => {
    const t = new URLSearchParams(window.location.search).get('tab')
    return VIEWS[t] ? t : 'directory'
  })
  const worklist = VIEWS[view]?.count ? VIEWS[view] : null
  // "several" was the chips' own rule (one undecided line is a row to look at,
  // a pile is a pattern worth a rule). On a page of its own it is a filter, not
  // the definition — otherwise a vendor with exactly one is unreachable.
  const [onlySeveral, setOnlySeveral] = useState(false)
  const goView = (next) => {
    setView(next)
    setOnlySeveral(false)
    const u = new URL(window.location.href)
    if (next === 'directory') u.searchParams.delete('tab'); else u.searchParams.set('tab', next)
    window.history.replaceState({}, '', u)
    const def = VIEWS[next]?.sort
    if (def) { setSortKey(def); setSortDir('desc') }
    else { setSortKey('relationship'); setSortDir('desc') }
  }
  const [dupCount, setDupCount] = useState(null)
  // Inline pickers: 'link:<key>' (unlinked payee → vendor) or 'merge:<name>'
  const [editor, setEditor] = useState(null)
  const [pickQ, setPickQ] = useState('')
  const [pickOpts, setPickOpts] = useState([])
  const pickTimer = useRef(null)
  const [busy, setBusy] = useState(false)

  const isAdminRole = user && (user.role === 'Admin' || user.role === 'Superadmin' || user.role === 'Approver')

  const fetchAll = async () => {
    try {
      const res = await api.get('/bk/vendors/unified')
      setVendors(res.data.data?.vendors || [])
      setUnlinked(res.data.data?.unlinked || [])
    } catch (err) {
      setError(err.response?.data?.error || err.message)
    } finally { setLoading(false) }
  }
  useEffect(() => { if (isAdminRole) fetchAll() }, [isAdminRole]) // eslint-disable-line react-hooks/exhaustive-deps

  const onPickQuery = (val) => {
    setPickQ(val)
    clearTimeout(pickTimer.current)
    if (val.trim().length < 2) { setPickOpts([]); return }
    pickTimer.current = setTimeout(async () => {
      try {
        const res = await api.get(`/bk/suggest-vendor?q=${encodeURIComponent(val.trim())}`)
        setPickOpts((res.data.data || []).slice(0, 8))
      } catch { setPickOpts([]) }
    }, 300)
  }
  const closeEditor = () => { setEditor(null); setPickQ(''); setPickOpts([]) }

  const linkPayee = async (payee, ledgerName) => {
    if (busy) return
    setBusy(true)
    try {
      await api.post('/statements/vendors/link', { bank_payee: payee, ledger_payee: ledgerName })
      closeEditor()
      await fetchAll()
    } catch (err) { alert('Failed: ' + (err.response?.data?.error || err.message)) }
    finally { setBusy(false) }
  }
  const mergeVendor = async (source, target) => {
    if (busy) return
    if (!window.confirm(`Merge "${source}" into "${target}"?\n\nAll of "${source}"'s entries are renamed, its bank links move to "${target}", and it becomes an alias.`)) return
    setBusy(true)
    try {
      const res = await api.post('/bk/vendors/merge', { source, target })
      closeEditor()
      await fetchAll()
      // Say what actually moved. A bank-only vendor merges 0 entries but
      // repoints its bank links, and silence there was indistinguishable from
      // the merge having failed.
      const { merged = 0, relinked = 0 } = res.data || {}
      setNotice(`Merged "${source}" into "${target}" — ${merged} entr${merged === 1 ? 'y' : 'ies'} renamed`
        + (relinked ? `, ${relinked} bank link${relinked === 1 ? '' : 's'} moved` : ''))
    } catch (err) { alert('Merge failed: ' + (err.response?.data?.error || err.message)) }
    finally { setBusy(false) }
  }

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    let out = vendors
    // The view decides the population. One place, so the tab's count, the
    // header's totals and the rows on screen cannot describe different sets.
    if (worklist) {
      out = out.filter((v) => worklist.count(v) > 0)
      if (onlySeveral) out = out.filter((v) => worklist.count(v) > 1)
    }
    if (needle) {
      out = out.filter((v) =>
        v.name.toLowerCase().includes(needle)
        || (v.aliases || '').toLowerCase().includes(needle)
        || (v.vendor_email || '').toLowerCase().includes(needle)
        || (v.bank?.learned_category || '').toLowerCase().includes(needle)
        || (v.bank?.payees || []).some((p) => (p || '').toLowerCase().includes(needle)))
    }
    const dir = sortDir === 'asc' ? 1 : -1
    const val = (v) => {
      if (sortKey === 'name') return v.name.toLowerCase()
      if (sortKey === 'invoices') return v.invoices
      if (sortKey === 'invoice_total') return Number(v.invoice_total)
      if (sortKey === 'bank_total') return Number(v.bank?.total || 0)
      if (sortKey === 'delta') return Number(v.bank?.total || 0) - Number(v.invoice_total || 0)
      if (sortKey === 'open') return Number(v.bank?.open_total || 0)
      if (sortKey === 'to_attach') return Number(v.to_attach || 0)
      if (sortKey === 'needs') return Number(v.bank?.needs_n || 0)
      if (sortKey === 'needs_artist') return Number(v.bank?.needs_artist_n || 0)
      if (sortKey === 'last_activity') return v.last_activity || ''
      return Number(v.relationship)
    }
    return [...out].sort((a, b) => {
      const av = val(a), bv = val(b)
      return (typeof av === 'string' ? av.localeCompare(bv) : av - bv) * dir
    })
  }, [vendors, q, sortKey, sortDir, view, onlySeveral])

  // Counted over EVERY vendor rather than the filtered list — a tab whose number
  // shrank as you typed in the search box would be describing the search, not
  // the backlog. The badge counts VENDORS, which is what the tab lists; the
  // header inside says how many lines and how much money that is.
  const viewCounts = useMemo(() => {
    const out = {}
    for (const [k, def] of Object.entries(VIEWS)) {
      if (!def.count) continue
      const hit = vendors.filter((v) => def.count(v) > 0)
      out[k] = {
        vendors: hit.length,
        several: hit.filter((v) => def.count(v) > 1).length,
        lines: hit.reduce((n, v) => n + def.count(v), 0),
        total: hit.reduce((n, v) => n + Number(def.total(v) || 0), 0),
      }
    }
    return out
  }, [vendors])

  const header = (key, label, cls = '') => (
    <th className={`px-3 py-2 text-left text-[10px] font-extrabold uppercase tracking-wider text-gray-400 cursor-pointer select-none whitespace-nowrap ${cls}`}
      onClick={() => sortKey === key ? setSortDir(sortDir === 'asc' ? 'desc' : 'asc') : (setSortKey(key), setSortDir(key === 'name' ? 'asc' : 'desc'))}>
      {label}{sortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
    </th>
  )

  const picker = (onPick) => (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-1">
        <input autoFocus value={pickQ} onChange={(e) => onPickQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && closeEditor()}
          placeholder="Search vendors…"
          className="w-44 border border-rule rounded-lg px-2 py-1 text-[12px] bg-card text-ink outline-none" />
        <button onClick={closeEditor} className="text-gray-300 hover:text-gray-500"><X size={13} /></button>
      </div>
      {pickOpts.length > 0 && (
        <div className="absolute z-20 mt-1 w-64 bg-card border border-rule rounded-lg shadow-lg overflow-hidden">
          {pickOpts.map((v) => (
            <button key={v.name} onClick={() => onPick(v.name)} disabled={busy}
              className="w-full text-left flex items-center gap-2 px-2.5 py-1.5 text-[12px] hover:bg-gray-50 disabled:opacity-50">
              <span className="font-semibold text-ink truncate">{v.name}</span>
              <span className="ml-auto text-[10px] text-gray-400 whitespace-nowrap">{v.invoice_count} inv</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )

  if (!isAdminRole) {
    return <div className="p-6 text-sm text-gray-500">Admin access required.</div>
  }

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <Building2 size={20} className="text-boom-600" />
        <h1 data-tour="vendors-header" className="text-xl font-extrabold text-ink">Vendors</h1>
      </div>
      <p className="text-sm text-gray-500 mb-3">
        {view === 'directory'
          ? 'One row per company — invoices and bank activity together. Click a vendor for its full detail; unlinked bank payees wait at the bottom until you give them an identity.'
          : view === 'duplicates'
            ? 'Vendors that look like the same company under two names. Merging is undoable.'
            : 'A worklist, not the whole directory — the vendors with this job waiting, biggest pile first. Click one to do it.'}
      </p>

      <div className="flex flex-wrap gap-1 mb-4">
        <button data-tour="vendors-views" onClick={() => goView('directory')}
          className={`px-3 py-1.5 rounded-lg text-sm font-semibold border ${view === 'directory' ? 'border-boom-600 text-boom-600 bg-boom-50/40' : 'border-rule text-gray-500 bg-card'}`}>
          Directory
        </button>
        {['needs', 'artist', 'attach'].map((k) => {
          const c = viewCounts[k]
          const tone = VIEWS[k].tone
          const badge = tone === 'rose' ? 'bg-rose-50 text-rose-700'
            : tone === 'violet' ? 'bg-violet-50 text-violet-700' : 'bg-amber-50 text-amber-700'
          const on = view === k
            ? (tone === 'rose' ? 'border-rose-500 text-rose-700 bg-rose-50/50'
              : tone === 'violet' ? 'border-violet-500 text-violet-700 bg-violet-50/50'
              : 'border-amber-500 text-amber-700 bg-amber-50/50')
            : 'border-rule text-gray-500 bg-card'
          return (
            <button key={k} onClick={() => goView(k)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold border whitespace-nowrap ${on}`}>
              {VIEWS[k].label}
              {c?.vendors > 0 && <span className={`text-[11px] font-extrabold px-1.5 py-0.5 rounded ${badge}`}>{c.vendors}</span>}
            </button>
          )
        })}
        <button onClick={() => goView('duplicates')}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold border ${view === 'duplicates' ? 'border-boom-600 text-boom-600 bg-boom-50/40' : 'border-rule text-gray-500 bg-card'}`}>
          <Flag size={13} /> Duplicates
          {dupCount > 0 && <span className="text-[11px] font-extrabold px-1.5 py-0.5 rounded bg-rose-50 text-rose-700">{dupCount}</span>}
        </button>
      </div>

      {view === 'duplicates' ? (
        <BkVendorFlags embedded onCount={setDupCount} />
      ) : (
      <>


      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative flex-1 min-w-[240px] max-w-md">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          <input data-tour="vendors-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search vendor, alias, email, bank payee…"
            className="w-full border border-rule rounded-xl pl-9 pr-3 py-2 text-sm bg-card text-ink" />
        </div>
      </div>

      {/* What this worklist IS, and how big. The chips it replaces carried this
          in a tooltip, which is where an explanation goes to die. */}
      {worklist && (() => {
        const c = viewCounts[view] || { vendors: 0, several: 0, lines: 0, total: 0 }
        const tone = worklist.tone
        const box = tone === 'rose' ? 'border-rose-200 bg-rose-50/50'
          : tone === 'violet' ? 'border-violet-200 bg-violet-50/50' : 'border-amber-200 bg-amber-50/50'
        return (
          <div className={`border rounded-xl px-4 py-3 mb-4 ${box}`}>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-[15px] font-extrabold text-ink">
                {c.vendors} vendor{c.vendors === 1 ? '' : 's'}
              </span>
              <span className="text-[13px] text-gray-600">
                {c.lines} line{c.lines === 1 ? '' : 's'} · {fmt(c.total)}
              </span>
              {c.several > 0 && (
                <label className="ml-auto inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-gray-600 cursor-pointer">
                  <input type="checkbox" checked={onlySeveral} onChange={() => setOnlySeveral((v) => !v)} />
                  Only the {c.several} with more than one
                </label>
              )}
            </div>
            <p className="text-[12.5px] text-gray-500 mt-1">{worklist.blurb}</p>
          </div>
        )
      })()}

      {error && <div className="bg-rose-50 border border-rose-200 text-rose-800 rounded-lg px-3 py-2 text-sm mb-4">{error}</div>}
      {notice && <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg px-3 py-2 text-sm mb-4">{notice}</div>}
      {loading ? (
        <div className="text-sm text-gray-400 py-8 text-center">Loading vendors…</div>
      ) : (
        <>
          <div className="bg-card border border-rule rounded-xl overflow-x-auto">
            <table data-tour="vendors-table" className="w-full" style={{ minWidth: 1080 }}>
              <thead>
                <tr className="border-b border-rule">
                  {header('name', 'Vendor')}
                  {header('invoices', 'Inv', 'text-right')}
                  {header('invoice_total', 'Invoiced', 'text-right')}
                  {header('bank_total', 'Bank out', 'text-right')}
                  {header('delta', 'Bank − invoiced', 'text-right')}
                  {header('open', 'Open', 'text-right')}
                  {header('needs', 'Needs matching', 'text-right')}
                  {header('needs_artist', 'Needs artist', 'text-right')}
                  {header('to_attach', 'To attach', 'text-right')}
                  <th className="px-3 py-2 text-left text-[10px] font-extrabold uppercase tracking-wider text-gray-400">W9</th>
                  <th className="px-3 py-2 text-left text-[10px] font-extrabold uppercase tracking-wider text-gray-400">Books as</th>
                  {header('last_activity', 'Last activity')}
                  <th className="px-3 py-2 w-20"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr><td colSpan={14} className="p-3">
                    {vendors.length === 0 ? (
                      <EmptyState
                        title="No vendors yet"
                        body="A vendor appears here with their first invoice — from the public form, or one you add. Their W-9, bank details and every invoice collect on their page."
                        action={{ label: 'Add invoice', to: '/bk/add' }}
                      >
                        <button type="button"
                          onClick={() => navigator.clipboard?.writeText(`${window.location.origin}/submit`)}
                          className="text-[12px] text-gray-500 hover:text-ink underline">
                          Copy the vendor form link
                        </button>
                      </EmptyState>
                    ) : (
                      <p className="px-3 py-8 text-center text-[12.5px] text-gray-400">No vendors match.</p>
                    )}
                  </td></tr>
                )}
                {filtered.map((v) => (
                  <tr key={v.name} className="border-b border-divider cursor-pointer hover:bg-gray-50 group"
                    onClick={() => navigate(`/bk/vendors/${encodeURIComponent(v.name)}`)}>
                    <td className="px-3 py-2">
                      <div className="text-[13px] font-bold text-ink truncate max-w-[240px]">{v.name}</div>
                      <div className="text-[11px] text-gray-400 truncate max-w-[240px]">
                        {v.aliases ? `aka ${v.aliases}` : v.vendor_email || ''}
                        {v.bank?.inferred && <span className="text-amber-600 font-semibold"> · bank link unconfirmed</span>}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-[12.5px]">{v.invoices || <span className="text-gray-300">—</span>}</td>
                    <td className="px-3 py-2 text-right font-mono text-[12.5px] font-bold">{v.invoice_total > 0 ? fmt(v.invoice_total) : <span className="text-gray-300">—</span>}</td>
                    <td className="px-3 py-2 text-right font-mono text-[12.5px]">{v.bank ? fmt(v.bank.total) : <span className="text-gray-300">—</span>}</td>
                    {(() => {
                      // Bank out vs invoiced. Positive = more cash left the
                      // bank than was ever invoiced (uninvoiced spend);
                      // negative = invoiced more than the bank shows
                      // (unpaid invoices, or paid from an unuploaded
                      // account). Within a wire-fee's width = balanced.
                      const delta = Number(v.bank?.total || 0) - Number(v.invoice_total || 0)
                      const basis = Math.max(Number(v.bank?.total || 0), Number(v.invoice_total || 0))
                      const balanced = basis === 0 || Math.abs(delta) <= Math.max(35, basis * 0.01)
                      return (
                        <td className={`px-3 py-2 text-right font-mono text-[12px] whitespace-nowrap ${
                          balanced ? 'text-emerald-600' : delta > 0 ? 'text-amber-600 font-bold' : 'text-gray-500'}`}
                          title={balanced ? 'Bank activity and invoices agree (within a wire fee)'
                            : delta > 0 ? `${fmt(delta)} more left the bank than this vendor ever invoiced — uninvoiced spend or a mis-linked bank payee`
                            : `${fmt(-delta)} invoiced beyond what the bank shows — unpaid invoices, or paid from an account with no statement`}>
                          {basis === 0 ? <span className="text-gray-300">—</span>
                            : balanced ? '✓'
                            : `${delta > 0 ? '+' : '−'}${fmt(Math.abs(delta))}`}
                        </td>
                      )
                    })()}
                    <td className="px-3 py-2 text-right font-mono text-[12.5px]">
                      {v.bank?.open_total > 0
                        ? <span className="text-rose-600 font-bold">{fmt(v.bank.open_total)} <span className="text-[10px] font-normal">({v.bank.open_n})</span></span>
                        : <span className="text-gray-300">—</span>}
                    </td>
                    {/* Payments with no invoice behind them and no rule saying
                        there'll never be one. The OPEN column beside it counts
                        only rows with NO ledger entry at all — 12 in the whole
                        system — which is why every vendor with a real pile reads
                        "—" there. Same definition as the Bank Matching queue. */}
                    <td className="px-3 py-2 text-right font-mono text-[12.5px]">
                      {v.bank?.needs_n > 0
                        ? <span className={v.bank.needs_n > 1 ? 'text-rose-600 font-bold' : 'text-gray-500'}
                            title={`${v.bank.needs_n} payment${v.bank.needs_n === 1 ? '' : 's'} to this vendor have no invoice behind them and no rule saying they never will — ${fmt(v.bank.needs_total)}. Open the vendor to attach invoices or mark them as never needing one.`}>
                            {v.bank.needs_n} <span className="text-[10px] font-normal">{fmt(v.bank.needs_total)}</span>
                          </span>
                        : <span className="text-gray-300">—</span>}
                    </td>
                    {/* Booked payments naming no artist, and nobody has said
                        this vendor's spend is overhead. Same predicate as the
                        attribution queue and as the vendor page's own band, so
                        the number you click is the number you land on. */}
                    <td className="px-3 py-2 text-right font-mono text-[12.5px]">
                      {v.bank?.needs_artist_n > 0
                        ? <span className={v.bank.needs_artist_n > 1 ? 'text-violet-700 font-bold' : 'text-gray-500'}
                            title={`${v.bank.needs_artist_n} booked payment${v.bank.needs_artist_n === 1 ? '' : 's'} to this vendor name no artist — ${fmt(v.bank.needs_artist_total)}. Open the vendor to attribute them, or mark its spend as overhead.`}>
                            {v.bank.needs_artist_n} <span className="text-[10px] font-normal">{fmt(v.bank.needs_artist_total)}</span>
                          </span>
                        : <span className="text-gray-300">—</span>}
                    </td>
                    {/* Invoices this vendor has that a bank line should settle
                        and none does — the work its own page can now do. Same
                        definition as the vendor page's header count, computed
                        server-side by the shared noBankEvidenceSql. */}
                    <td className="px-3 py-2 text-right font-mono text-[12.5px]">
                      {v.to_attach > 0
                        ? <span className="text-amber-700 font-bold"
                            title={`${v.to_attach} invoice${v.to_attach === 1 ? '' : 's'} marked Paid with a covering statement on file and no bank line attached — ${fmt(v.to_attach_total)}. Open the vendor to attach them.`}>
                            {v.to_attach} <span className="text-[10px] font-normal">{fmt(v.to_attach_total)}</span>
                          </span>
                        : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-3 py-2 text-[12.5px]">
                      {v.w9_on_file
                        ? <span className="text-emerald-600 font-bold">✓</span>
                        : v.invoices > 0
                          ? <span className="text-amber-600 font-semibold text-[11px]" title="No W9 on file — open the vendor to chase one">missing</span>
                          : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-3 py-2 text-[12.5px]">
                      {v.bank?.learned_category
                        ? <span className="inline-flex items-center gap-1 text-emerald-700 font-semibold"><Zap size={11} /> {v.bank.learned_category}</span>
                        : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-3 py-2 font-mono text-[12px] text-gray-500">{fmtDay(v.last_activity)}</td>
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      {editor === `merge:${v.name}` ? picker((target) => mergeVendor(v.name, target)) : (
                        <div className="flex items-center justify-end gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          {v.bank && (
                            <button onClick={() => navigate(`/bk/statements?q=${encodeURIComponent((v.bank.payees || [])[0] || v.name)}`)}
                              title="Review this vendor's bank transactions" className="text-gray-400 hover:text-boom-600 p-0.5">
                              <ExternalLink size={13} />
                            </button>
                          )}
                          <button onClick={() => { setEditor(`merge:${v.name}`); setPickQ(''); setPickOpts([]) }}
                            title="Merge this vendor into another" className="text-gray-400 hover:text-boom-600 p-0.5">
                            <GitMerge size={13} />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-gray-400 mt-2">{filtered.length} vendor{filtered.length === 1 ? '' : 's'} · sorted by relationship $ (invoiced + open bank) · Bank − invoiced: ✓ agree within a wire fee, <span className="text-amber-600 font-semibold">+amber</span> = cash out beyond invoices, − = invoiced beyond bank evidence · ⚡ = learned booking category · hover a row for review/merge actions</p>

          {/* Unlinked bank payees — the finishable identity queue. Directory
              only: on a worklist it is a second, unrelated pile at the bottom
              of a page that exists to be finished. */}
          {view === 'directory' && unlinked.length > 0 && (
            <div className="bg-card border border-rule rounded-xl overflow-hidden mt-5">
              <button onClick={() => setUnlinkedOpen(!unlinkedOpen)} className="w-full flex items-center gap-2 px-4 py-2.5 text-left">
                {unlinkedOpen ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />}
                <span className="text-sm font-bold text-gray-500">Unlinked bank payees — {unlinked.length}</span>
                <span className="text-xs text-gray-400">({fmt(unlinked.reduce((s, u) => s + Number(u.total), 0))}) — link each to a vendor, or review its transactions</span>
              </button>
              {unlinkedOpen && unlinked.map((u) => (
                <div key={u.key} className="flex items-center gap-3 px-4 py-2 border-t border-divider text-[13px]">
                  <span className="font-semibold text-ink truncate max-w-[220px]">{u.name}</span>
                  <span className="text-[11px] text-gray-400 whitespace-nowrap">{u.txns} txn{u.txns === 1 ? '' : 's'} · {fmt(u.total)}</span>
                  {u.open_total > 0 && <span className="text-[11px] text-rose-600 font-bold whitespace-nowrap">{fmt(u.open_total)} open</span>}
                  <span className="text-[11px] text-gray-400 font-mono">{fmtDay(u.last_seen)}</span>
                  <div className="ml-auto flex items-center gap-2">
                    {editor === `link:${u.key}` ? picker((name) => linkPayee(u.name, name)) : (
                      <>
                        <button onClick={() => { setEditor(`link:${u.key}`); setPickQ(''); setPickOpts([]) }}
                          className="inline-flex items-center gap-1 text-[11px] font-bold text-boom-600 hover:underline">
                          <Link2 size={11} /> Link…
                        </button>
                        <button onClick={() => navigate(`/bk/statements?q=${encodeURIComponent(u.name)}`)}
                          className="text-[11px] font-bold text-gray-400 hover:text-gray-600">review →</button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      </>
      )}
    </div>
  )
}
