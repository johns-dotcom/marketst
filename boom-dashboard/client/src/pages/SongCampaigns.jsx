// Song Campaigns — the marketing team's board (2026-09-21, John: "a really good
// system for the marketing team to track spending for song campaigns and when
// they're finished spending and can confirm it's done, mark the campaign as
// ready to upload for recoupment").
//
// One campaign per song: a budget, an owner, expected-spend lines, and the
// spend the ledger already attributes to that artist + song. A card reads
// Budget · Spent · Committed · Expected · Left as one bar. Five columns are the
// lifecycle; the drawer holds the checklist and the confirm. Filters live in
// the URL (q owner status artist attn view campaign); ?campaign=ID opens one.
import { useState, useEffect, useMemo, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Plus, X, LayoutGrid, List as ListIcon, Search, AlertTriangle, ChevronRight, Paperclip } from 'lucide-react'
import api from '../api'
import Skeleton from '../components/Skeleton'
import PageHeader from '../components/PageHeader'
import EmptyState from '../components/EmptyState'
import usePageShortcuts from '../hooks/usePageShortcuts'
import useListKeys, { focusFilter } from '../hooks/useListKeys'
import { useAuth } from '../context/AuthContext'
import useArtistNames from '../hooks/useArtistNames'
import ArtistSelect from '../components/ArtistSelect'
import CampaignDrawer from '../components/campaigns/CampaignDrawer'
import { STATUSES, STATUS_SHORT, STATUS_LABEL, STATUS_DOT, STATUS_HEADER, NEXT_ACTION, FILTER_KEYS, filterCampaigns, sumBy, fmtMoney, barShares, needsAttention, attentionLine, initials, relTime, daysFromToday } from '../lib/campaigns'

export default function SongCampaigns() {
  const { user } = useAuth()
  const [list, setList] = useState(null)
  const [team, setTeam] = useState([])
  const [error, setError] = useState('')
  const [searchParams, setSearchParams] = useSearchParams()
  const filters = useMemo(() => Object.fromEntries(FILTER_KEYS.map((k) => [k, searchParams.get(k) || ''])), [searchParams])
  const setFilter = useCallback((patch) => {
    const next = new URLSearchParams(searchParams)
    for (const [k, v] of Object.entries(patch)) { if (v === '' || v === null || v === undefined) next.delete(k); else next.set(k, String(v)) }
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])
  const view = filters.view === 'list' ? 'list' : 'board'
  const [showForm, setShowForm] = useState(() => searchParams.get('new') === '1')

  const load = useCallback(async () => {
    try { const r = await api.get('/campaigns'); setList(r.data?.data || []) } catch (e) { setError(e?.response?.data?.error || 'Could not load campaigns'); setList([]) }
  }, [])
  useEffect(() => { load(); api.get('/team').then((r) => setTeam(r.data?.data || [])).catch(() => {}) }, [load])

  const selectedId = filters.campaign ? Number(filters.campaign) : null
  const open = (c) => setFilter({ campaign: c ? c.id : '' })
  const upsert = (c) => { if (!c) return; setList((prev) => (prev || []).some((x) => x.id === c.id) ? prev.map((x) => (x.id === c.id ? { ...x, ...c, ledger: undefined } : x)) : [c, ...(prev || [])]) }
  const remove = (id) => setList((prev) => (prev || []).filter((x) => x.id !== id))

  const keys = useListKeys({ enabled: !selectedId && !showForm })
  usePageShortcuts('/campaigns', { n: () => setShowForm(true), f: () => focusFilter(), j: () => keys.next(), k: () => keys.prev(), Enter: () => keys.open() })

  const advance = async (c) => {
    const [status] = NEXT_ACTION[c.status] || []
    if (!status) return
    if (status === 'ready' && !c.ready) { open(c); return }   // the drawer collects the note
    try { const r = await api.post(`/campaigns/${c.id}/status`, { status }); upsert(r.data.data) } catch (e) { setError(e?.response?.data?.error || 'Could not move the campaign') }
  }

  const all = list || []
  const visible = useMemo(() => filterCampaigns(all, filters, user?.id), [all, filters, user?.id])
  const grouped = useMemo(() => { const g = {}; for (const s of STATUSES) g[s] = visible.filter((c) => c.status === s); return g }, [visible])
  const liveAll = all.filter((c) => !['uploaded'].includes(c.status))
  const attn = all.filter(needsAttention).length
  const activeFilters = ['q', 'owner', 'status', 'artist', 'attn'].filter((k) => filters[k]).length
  const artists = useMemo(() => [...new Map(all.map((c) => [c.artist_key, c.artist])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [all])

  if (list === null) return <div className="space-y-6"><Skeleton.PageHeader /><Skeleton.KanbanBoard cols={5} cards={2} /></div>

  return (
    <div className="space-y-4">
      <PageHeader tour="song-campaigns-header" title="Song Campaigns"
        subtitle={all.length ? `${liveAll.length} open · ${fmtMoney(sumBy(liveAll, 'budget_usd'))} budgeted · ${fmtMoney(sumBy(liveAll, 'spent'))} spent · ${fmtMoney(sumBy(liveAll, 'committed'))} committed · ${grouped.ready.length + all.filter((c) => c.status === 'ready').length - grouped.ready.length} ready for recoupment${attn ? ` · ${attn} need attention` : ''}` : 'One campaign per song: a budget, an owner, and the spend the ledger attributes to it'}
        actions={(
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-lg border border-rule bg-card p-0.5" role="tablist" data-tour="song-campaigns-views">
              {[['board', LayoutGrid, 'Board'], ['list', ListIcon, 'List']].map(([id, Icon, label]) => (
                <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => setFilter({ view: id === 'board' ? '' : id })} data-campaigns-view={id}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium ${view === id ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'}`}><Icon size={13} /> <span className="hidden sm:inline">{label}</span></button>
              ))}
            </div>
            <button data-tour="song-campaigns-new" onClick={() => setShowForm((v) => !v)} className="btn-primary"><Plus size={16} /> New campaign</button>
          </div>
        )} />

      <div className="flex items-center gap-2 flex-wrap" data-tour="song-campaigns-filters">
        <label className="relative"><Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={filters.q} onChange={(e) => setFilter({ q: e.target.value })} placeholder="Search artist, song, owner…" data-filter className="input-base pl-7 py-1.5 text-sm w-60" aria-label="Search campaigns" /></label>
        <select value={filters.owner} onChange={(e) => setFilter({ owner: e.target.value })} className="select-base text-xs py-1.5" aria-label="Owner" data-campaigns-owner>
          <option value="">Everyone</option><option value="me">Mine</option>
          {team.filter((m) => String(m.id) !== String(user?.id)).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <select value={filters.artist} onChange={(e) => setFilter({ artist: e.target.value })} className="select-base text-xs py-1.5" aria-label="Artist"><option value="">Any artist</option>{artists.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>
        {view === 'list' && <select value={filters.status} onChange={(e) => setFilter({ status: e.target.value })} className="select-base text-xs py-1.5" aria-label="Status"><option value="">Any status</option>{STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select>}
        <button type="button" onClick={() => setFilter({ attn: filters.attn === '1' ? '' : '1' })} aria-pressed={filters.attn === '1'} data-campaigns-attn
          className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border ${filters.attn === '1' ? 'bg-rose-600 text-white border-rose-600' : 'bg-card text-gray-600 border-rule hover:bg-gray-50'}`}>
          <AlertTriangle size={12} /> Needs attention{attn ? ` · ${attn}` : ''}
        </button>
        {activeFilters > 0 && <button type="button" onClick={() => setFilter({ q: '', owner: '', status: '', artist: '', attn: '' })} className="text-xs text-gray-500 hover:text-gray-900 inline-flex items-center gap-1" data-campaigns-clear><X size={11} /> Clear</button>}
      </div>

      {showForm && <NewCampaign team={team} user={user} onClose={() => setShowForm(false)} onCreated={(c) => { upsert(c); setShowForm(false); open(c) }} setError={setError} />}
      {error && <div className="text-sm text-red-600 flex items-center justify-between bg-red-50 border border-red-200 rounded-lg px-3 py-2"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss" className="p-0.5"><X size={14} /></button></div>}

      <div data-tour="song-campaigns-board" data-campaigns-board>
        {all.length === 0 && !showForm ? (
          <EmptyState title="No song campaigns yet" body="A campaign is one song's push: its budget, who runs it, the spend you expect, and the invoices the ledger already attributes to it. When spending is done, confirm it and bookkeeping uploads it for recoupment." action={{ label: 'New campaign', onClick: () => setShowForm(true) }} />
        ) : view === 'list' ? (
          <CampaignTable rows={visible} onOpen={open} />
        ) : (
          <>
            {visible.length === 0 && <p className="text-sm text-gray-400 text-center py-3" data-campaigns-nomatch>No campaigns match these filters.</p>}
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
              {STATUSES.map((s) => (
                <div key={s} data-campaign-column={s} className="rounded-xl border border-rule bg-card p-3 min-h-[10rem]">
                  <div className="flex items-center gap-2 mb-3 pb-2 border-b border-divider">
                    <div className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_DOT[s]}`} />
                    <h3 className={`text-[11px] font-bold uppercase tracking-wider flex-1 ${STATUS_HEADER[s]}`}>{STATUS_SHORT[s]}</h3>
                    {grouped[s].length > 0 && <span className="text-[10px] font-semibold text-gray-500 tabular-nums" data-column-sum>{fmtMoney(sumBy(grouped[s], 'spent') + sumBy(grouped[s], 'committed'))}</span>}
                    {grouped[s].length > 0 && <span className="text-[10px] font-bold text-gray-400 bg-gray-100 rounded px-1.5 py-0.5 tabular-nums" data-column-count>{grouped[s].length}</span>}
                  </div>
                  <div className="space-y-2">{grouped[s].map((c) => <CampaignCard key={c.id} c={c} onOpen={open} onAdvance={advance} />)}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {selectedId && <CampaignDrawer id={selectedId} team={team} user={user} onClose={() => open(null)} onChange={upsert} onDeleted={(id) => { remove(id); open(null) }} />}
    </div>
  )
}

export function BudgetBar({ c, compact = false }) {
  const s = barShares(c)
  return (
    <div className={`relative w-full ${compact ? 'h-1.5' : 'h-2.5'} rounded bg-gray-100 overflow-hidden`} title={`Spent ${fmtMoney(c.spent)} · committed ${fmtMoney(c.committed)} · expected ${fmtMoney(c.expected_open)}${c.budget_usd ? ` · budget ${fmtMoney(c.budget_usd)}` : ''}`} data-budget-bar>
      <div className="absolute inset-y-0 left-0 bg-emerald-500" style={{ width: `${s.spent}%` }} />
      <div className="absolute inset-y-0 bg-amber-400" style={{ left: `${s.spent}%`, width: `${s.committed}%` }} />
      <div className="absolute inset-y-0 bg-gray-300" style={{ left: `${s.spent + s.committed}%`, width: `${s.expected}%` }} />
      {s.budgetAt !== null && s.budgetAt < 100 && <div className="absolute inset-y-0 w-0.5 bg-gray-900" style={{ left: `${s.budgetAt}%` }} title="Budget" />}
    </div>
  )
}

function CampaignCard({ c, onOpen, onAdvance }) {
  const next = NEXT_ACTION[c.status]
  const attnText = attentionLine(c)
  return (
    <div data-campaign-card={c.id} data-row data-attn={needsAttention(c) ? '1' : '0'} className={`p-2.5 rounded-lg border bg-card hover:shadow-sm transition-all group ${c.over_budget && c.status !== 'uploaded' ? 'border-rose-200' : 'border-gray-150 hover:border-gray-300'}`}>
      <button onClick={() => onOpen(c)} className="w-full text-left" data-row-open data-campaign-open>
        <div className="flex items-start gap-1.5">
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-semibold text-gray-900 truncate leading-tight">{c.song}</p>
            <p className="text-[11px] text-gray-500 truncate">{c.artist}{c.release_name && c.release_name !== c.song ? ` · ${c.release_name}` : ''}</p>
          </div>
          {c.owner_name && <span title={`Owner: ${c.owner_name}`} className="w-5 h-5 rounded-full bg-boom-100 text-boom-700 text-[9px] font-bold inline-flex items-center justify-center flex-shrink-0" data-campaign-owner>{initials(c.owner_name)}</span>}
        </div>
        <div className="mt-2"><BudgetBar c={c} compact /></div>
        <div className="flex items-center justify-between mt-1 text-[10px] tabular-nums">
          <span className="text-gray-700"><span className="font-semibold">{fmtMoney(c.spent)}</span> spent{c.committed > 0 && <span className="text-amber-700"> · {fmtMoney(c.committed)} in</span>}{c.expected_open > 0 && <span className="text-gray-400"> · {fmtMoney(c.expected_open)} expected</span>}</span>
          <span className={c.left === null ? 'text-gray-300' : c.left < 0 ? 'text-rose-600 font-semibold' : 'text-gray-500'} data-campaign-left>{c.left === null ? 'no budget' : c.left < 0 ? `${fmtMoney(-c.left)} over` : `${fmtMoney(c.left)} left`}</span>
        </div>
        {attnText && <p className="text-[10px] text-rose-600 font-medium mt-1 truncate" data-campaign-attn>{attnText}</p>}
        <p className="text-[10px] text-gray-400 mt-1 truncate">
          {c.rows} invoice{c.rows === 1 ? '' : 's'}{c.unpaid ? ` · ${c.unpaid} unpaid` : ''}{c.no_doc ? ` · ${c.no_doc} no doc` : ''}{c.lines_open ? ` · ${c.lines_open} expected` : ''}
          {c.end_date && ['planning', 'live'].includes(c.status) && ` · ends ${daysFromToday(c.end_date) >= 0 ? `in ${daysFromToday(c.end_date)}d` : `${-daysFromToday(c.end_date)}d ago`}`}
          {c.status === 'ready' && c.confirmed_at && ` · confirmed ${relTime(c.confirmed_at)}`}
        </p>
      </button>
      {next && (
        <button onClick={() => onAdvance(c)} className={`mt-1.5 w-full flex items-center justify-center gap-0.5 text-[11px] font-medium py-0.5 rounded transition-all ${c.status === 'finished' ? (c.ready ? 'text-emerald-700 hover:bg-emerald-50' : 'text-amber-700 hover:bg-amber-50') : 'text-gray-400 hover:text-boom-600 hover:bg-boom-50/50'}`} data-campaign-next>
          {next[1]}{c.status === 'finished' && !c.ready ? ' (with a note)' : ''} <ChevronRight size={11} />
        </button>
      )}
    </div>
  )
}

function CampaignTable({ rows, onOpen }) {
  return (
    <div className="bg-card border border-rule rounded-xl overflow-x-auto" data-campaigns-list>
      <table className="w-full text-sm">
        <thead className="border-b border-divider bg-gray-50/60"><tr>{['Song', 'Artist', 'Status', 'Owner', 'Budget', 'Spent', 'Committed', 'Expected', 'Left', 'Invoices', 'Ends'].map((h) => <th key={h} className={`px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-gray-500 whitespace-nowrap ${['Budget', 'Spent', 'Committed', 'Expected', 'Left', 'Invoices'].includes(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id} data-row data-campaign-row={c.id} onClick={() => onOpen(c)} className="border-b border-divider last:border-0 hover:bg-gray-50/70 cursor-pointer">
              <td className="px-3 py-2 min-w-[12rem]"><button type="button" data-row-open className="text-left font-semibold text-gray-900 hover:underline" onClick={(e) => { e.stopPropagation(); onOpen(c) }}>{c.song}</button>{attentionLine(c) && <span className="block text-[10px] text-rose-600">{attentionLine(c)}</span>}</td>
              <td className="px-3 py-2 text-xs text-gray-700 whitespace-nowrap">{c.artist}</td>
              <td className="px-3 py-2 whitespace-nowrap"><span className="inline-flex items-center gap-1.5 text-xs text-gray-700"><span className={`w-2 h-2 rounded-full ${STATUS_DOT[c.status]}`} />{STATUS_SHORT[c.status]}</span></td>
              <td className="px-3 py-2 text-xs text-gray-700 whitespace-nowrap">{c.owner_name || <span className="text-gray-300">—</span>}</td>
              <td className="px-3 py-2 text-right tabular-nums text-xs">{c.budget_usd === null ? <span className="text-gray-300">—</span> : fmtMoney(c.budget_usd)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-xs text-emerald-700">{fmtMoney(c.spent)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-xs text-amber-700">{c.committed ? fmtMoney(c.committed) : <span className="text-gray-300">—</span>}</td>
              <td className="px-3 py-2 text-right tabular-nums text-xs text-gray-500">{c.expected_open ? fmtMoney(c.expected_open) : <span className="text-gray-300">—</span>}</td>
              <td className={`px-3 py-2 text-right tabular-nums text-xs ${c.left !== null && c.left < 0 ? 'text-rose-600 font-semibold' : 'text-gray-700'}`}>{c.left === null ? <span className="text-gray-300">—</span> : c.left < 0 ? `-${fmtMoney(-c.left)}` : fmtMoney(c.left)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-xs text-gray-600">{c.rows}{c.unpaid ? <span className="text-amber-700"> · {c.unpaid} unpaid</span> : ''}{c.no_doc ? <span className="text-gray-400 inline-flex items-center gap-0.5 ml-1"><Paperclip size={9} />{c.no_doc}</span> : ''}</td>
              <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">{c.end_date ? String(c.end_date).slice(0, 10) : <span className="text-gray-300">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="px-4 py-8 text-center text-sm text-gray-400">No campaigns match these filters.</p>}
    </div>
  )
}

// New campaign: artist from the roster ∪ ledger names (the same picker the
// approvals checklist uses), the song from that artist's releases or ledger,
// a budget, an owner, dates, and the expected lines.
function NewCampaign({ team, user, onClose, onCreated, setError }) {
  const names = useArtistNames()
  const [form, setForm] = useState({ artist: '', song: '', budget: '', owner_id: user?.id || '', start_date: '', end_date: '', notes: '', status: 'planning' })
  const [songs, setSongs] = useState({ releases: [], ledger: [], existing: [] })
  const [lines, setLines] = useState([{ label: '', category: '', vendor: '', expected_amount: '' }])
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (!form.artist) { setSongs({ releases: [], ledger: [], existing: [] }); return }
    let live = true
    api.get('/campaigns/songs', { params: { artist: form.artist } }).then((r) => { if (live) setSongs(r.data?.data || { releases: [], ledger: [], existing: [] }) }).catch(() => {})
    return () => { live = false }
  }, [form.artist])
  const songOptions = [...new Set([...songs.releases.map((r) => r.project_name), ...songs.ledger])]
  const taken = new Set(songs.existing.map((e) => e.song.toLowerCase()))
  const submit = async (e) => {
    e.preventDefault()
    if (!form.artist.trim() || !form.song.trim()) { setError('An artist and a song are required'); return }
    setSaving(true)
    try {
      const release = songs.releases.find((r) => r.project_name.toLowerCase() === form.song.trim().toLowerCase())
      const r = await api.post('/campaigns', { ...form, owner_id: form.owner_id || null, budget: form.budget === '' ? null : Number(form.budget), release_id: release?.id || null, lines: lines.filter((l) => l.label.trim()) })
      onCreated(r.data.data)
    } catch (err) { setError(err?.response?.data?.error || 'Could not create the campaign') } finally { setSaving(false) }
  }
  return (
    <form onSubmit={submit} className="bg-card border border-rule rounded-xl p-5 shadow-sm space-y-4" data-campaign-form>
      <div className="flex justify-between items-center"><h2 className="text-sm font-semibold text-gray-900">New song campaign</h2><button type="button" onClick={onClose} aria-label="Close" className="p-1 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"><X size={18} /></button></div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Artist</span>
          <ArtistSelect value={form.artist} onChange={(v) => setForm((f) => ({ ...f, artist: v, song: '' }))} options={names} placeholder="Artist…" className="mt-1" /></label>
        <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Song</span>
          <input list="campaign-song-options" value={form.song} onChange={(e) => setForm((f) => ({ ...f, song: e.target.value }))} placeholder={songOptions.length ? 'Pick a release or type a song' : 'Song or project'} className="input-base mt-1 w-full" aria-label="Song" data-campaign-song required />
          <datalist id="campaign-song-options">{songOptions.map((s) => <option key={s} value={s} />)}</datalist>
          {taken.has(form.song.trim().toLowerCase()) && <span className="text-[11px] text-amber-700">A campaign for this song already exists.</span>}</label>
        <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Budget (USD)</span>
          <input type="number" step="1" min="0" value={form.budget} onChange={(e) => setForm((f) => ({ ...f, budget: e.target.value }))} className="input-base mt-1 w-full" placeholder="e.g. 5000" aria-label="Budget" data-campaign-budget /></label>
        <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Owner</span>
          <select value={form.owner_id} onChange={(e) => setForm((f) => ({ ...f, owner_id: e.target.value }))} className="select-base mt-1 w-full" aria-label="Owner" data-campaign-owner-select>{team.map((m) => <option key={m.id} value={m.id}>{String(m.id) === String(user?.id) ? `Me (${m.name})` : m.name}</option>)}{!team.length && <option value={user?.id || ''}>Me</option>}</select></label>
        <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Starts</span><input type="date" value={form.start_date} onChange={(e) => setForm((f) => ({ ...f, start_date: e.target.value }))} className="input-base mt-1 w-full" aria-label="Start date" /></label>
        <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Ends</span><input type="date" value={form.end_date} onChange={(e) => setForm((f) => ({ ...f, end_date: e.target.value }))} className="input-base mt-1 w-full" aria-label="End date" /></label>
      </div>
      <div data-campaign-form-lines>
        <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1">Expected spend · what you plan to buy (each line is ticked off when its invoice arrives)</p>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[2fr_1fr_1fr_6rem_2rem] gap-2 mb-1.5">
            <input value={l.label} onChange={(e) => setLines((ls) => ls.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)))} placeholder="Instagram ads, PR retainer, 20 creators…" className="input-base text-sm" aria-label="Line" data-line-label />
            <input value={l.category} onChange={(e) => setLines((ls) => ls.map((x, k) => (k === i ? { ...x, category: e.target.value } : x)))} placeholder="Category" className="input-base text-sm" aria-label="Category" />
            <input value={l.vendor} onChange={(e) => setLines((ls) => ls.map((x, k) => (k === i ? { ...x, vendor: e.target.value } : x)))} placeholder="Vendor" className="input-base text-sm" aria-label="Vendor" />
            <input type="number" step="1" min="0" value={l.expected_amount} onChange={(e) => setLines((ls) => ls.map((x, k) => (k === i ? { ...x, expected_amount: e.target.value } : x)))} placeholder="$" className="input-base text-sm" aria-label="Expected amount" data-line-amount />
            <button type="button" onClick={() => setLines((ls) => ls.filter((_, k) => k !== i))} aria-label="Remove line" className="text-gray-300 hover:text-rose-600"><X size={14} /></button>
          </div>
        ))}
        <button type="button" onClick={() => setLines((ls) => [...ls, { label: '', category: '', vendor: '', expected_amount: '' }])} className="text-xs text-boom-600 hover:underline" data-line-add>+ Add a line</button>
      </div>
      <textarea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} rows={2} placeholder="First note — the plan in a sentence" className="input-base w-full" aria-label="Notes" />
      <div className="flex items-center gap-2 justify-end">
        <label className="text-xs text-gray-500 inline-flex items-center gap-1.5 mr-auto"><input type="checkbox" checked={form.status === 'live'} onChange={(e) => setForm((f) => ({ ...f, status: e.target.checked ? 'live' : 'planning' }))} /> Already spending (start it Live)</label>
        <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
        <button type="submit" disabled={saving} className="btn-primary" data-campaign-form-submit>{saving ? 'Creating…' : 'Create campaign'}</button>
      </div>
    </form>
  )
}
