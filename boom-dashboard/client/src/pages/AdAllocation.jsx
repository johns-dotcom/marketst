// Allocate Advertising — putting an artist's name on ad-platform spend.
//
// ── The problem, measured ──
// 495 of the 499 `Advertisements` ledger rows ($291,299) name no artist, and none
// carries a song. There is nothing on the charge to attribute FROM: the
// descriptors are merchant ids repeated on every one of the 264 Facebook charges
// (`PURCHASE 0724 FACEBK *F4EE6X5GP2`). Marketing, by contrast, is 1,168 rows with
// only 122 unattributed — because those arrive as invoices that name the work.
//
// ── Why the existing mechanism was not enough ──
// `ad_pool_allocations` already routed this spend to a label-level bucket and let
// somebody assign amounts out of it. It has NEVER been used: $267,674 of pool
// across Feb–Jul 2026 and zero allocations in six months. Two reasons, both fixed
// here — it asked for a dollar figure with no campaign and no charge list, so the
// guess was unfalsifiable; and it wrote nothing to the ledger, so an allocation
// was invisible to Recoupments, the artist spend sheets and the recoupment audit.
//
// So: a campaign is the basis, and the write is a real split family whose slices
// are marked reviewed and recoupable — the supported way onto the recoupment
// surfaces (`withoutUnreviewedBankRows`).
//
// ── Bank is the money, Ads Manager is the basis ──
// Only real charges are ever apportioned. An export supplies proportions and
// nothing else, so there is no reconciliation remainder to park anywhere.
//
// Data comes from three endpoints and this page derives no money of its own:
//   GET  /reports/ad-months    which months hold pool, oldest first
//   GET  /reports/ad-charges   one month: its charges, allocations, campaigns
//   POST /reports/ad-allocate  dry_run for the preview, then the same call to write

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Plus, Upload, Info } from 'lucide-react'
import api from '../api'
import PageHeader from '../components/PageHeader'
import Skeleton from '../components/Skeleton'
import ChargeTable from '../components/adalloc/ChargeTable'
import AllocatePanel from '../components/adalloc/AllocatePanel'
import ImportMapper from '../components/adalloc/ImportMapper'

const usd = (n) => (Number(n) || 0).toLocaleString('en-US',
  { style: 'currency', currency: 'USD', minimumFractionDigits: 2 })
const usd0 = (n) => (Number(n) || 0).toLocaleString('en-US',
  { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const monthLabel = (m) => {
  if (!/^\d{4}-\d{2}$/.test(String(m || ''))) return String(m || '')
  const [y, mo] = m.split('-')
  return `${['', 'January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'][Number(mo)]} ${y}`
}

export default function AdAllocation() {
  // State first, and above everything that derives from it — a const read before
  // its own declaration compiles clean and blanks the page (ARRAY_CALLBACK_TDZ).
  const [months, setMonths] = useState(null)
  const [month, setMonth] = useState('')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState(null)
  const [pendingReq, setPendingReq] = useState(null)
  const [panelErr, setPanelErr] = useState('')
  const [mode, setMode] = useState('one')       // 'one' | 'import'
  const [newCamp, setNewCamp] = useState(null)
  const [flash, setFlash] = useState('')

  // Which months hold pool. Loaded once; the page opens on the OLDEST with money
  // in it, because that is the backlog John chose to work oldest-first.
  useEffect(() => {
    let live = true
    api.get('/reports/ad-months')
      .then((r) => {
        if (!live) return
        const list = r.data?.data?.months || []
        setMonths(list)
        setMonth((m) => m || (list.length ? list[0].month : new Date().toISOString().slice(0, 7)))
      })
      .catch((e) => { if (live) { setErr(e?.response?.data?.error || e.message); setMonths([]) } })
    return () => { live = false }
  }, [])

  const load = useCallback(async (m) => {
    if (!m) return
    setLoading(true); setErr('')
    try {
      const r = await api.get(`/reports/ad-charges?month=${m}`)
      setData(r.data?.data || null)
    } catch (e) {
      setErr(e?.response?.data?.error || e.message)
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { load(month) }, [month, load])

  const charges = data?.charges || []
  const campaigns = data?.campaigns || []
  const openDollars = (data?.allocatable_cents || 0) / 100
  const blockedDollars = ((data?.open_cents || 0) - (data?.allocatable_cents || 0)) / 100
  const allocatedDollars = (data?.allocated_cents || 0) / 100

  const monthIdx = useMemo(
    () => (months || []).findIndex((x) => x.month === month), [months, month])
  const step = (d) => {
    const list = months || []
    const i = monthIdx + d
    if (i >= 0 && i < list.length) setMonth(list[i].month)
  }

  const clearPreview = () => { setPreview(null); setPendingReq(null); setPanelErr('') }

  const doPreview = async (payload) => {
    setBusy(true); setPanelErr(''); setPreview(null)
    try {
      const body = { month, dry_run: true, ...payload }
      const r = await api.post('/reports/ad-allocate', body)
      setPreview(r.data?.data || null)
      setPendingReq(body)
    } catch (e) {
      setPanelErr(e?.response?.data?.error || e.message)
    } finally {
      setBusy(false)
    }
  }

  const doApply = async () => {
    if (!pendingReq) return
    setBusy(true); setPanelErr('')
    try {
      const { dry_run, ...write } = pendingReq
      const r = await api.post('/reports/ad-allocate', write)
      const w = r.data?.data
      setFlash(`Allocated ${usd(w.total)} across ${w.per_charge.length} charge`
        + `${w.per_charge.length === 1 ? '' : 's'} — ${w.written.slices + w.written.charges} ledger `
        + 'row(s) written, marked reviewed and recoupable.')
      clearPreview()
      setMode('one')
      await load(month)
      // The month strip's figures came from the same derivation and have moved.
      api.get('/reports/ad-months').then((x) => setMonths(x.data?.data?.months || [])).catch(() => {})
    } catch (e) {
      setPanelErr(e?.response?.data?.error || e.message)
    } finally {
      setBusy(false)
    }
  }

  const undo = async (a) => {
    if (!window.confirm(`Return ${usd(a.cents / 100)} from ${a.artist} to the pool?`)) return
    setBusy(true)
    try {
      await api.delete(`/reports/ad-allocate/${a.expense_id}`)
      setFlash(`Returned ${usd(a.cents / 100)} to the pool.`)
      await load(month)
      api.get('/reports/ad-months').then((x) => setMonths(x.data?.data?.months || [])).catch(() => {})
    } catch (e) {
      setErr(e?.response?.data?.error || e.message)
    } finally {
      setBusy(false)
    }
  }

  const createCampaign = async (form) => {
    setBusy(true)
    try {
      await api.post('/marketing/campaigns', {
        name: form.name, platform: form.platform || 'Facebook',
        artist_id: form.artist_id ? Number(form.artist_id) : null,
        release_id: form.release_id ? Number(form.release_id) : null,
        total_budget: form.total_budget ? Number(form.total_budget) : null,
        campaign_date: `${month}-15`,
      })
      setNewCamp(null)
      await load(month)
    } catch (e) {
      setErr(e?.response?.data?.error || e.message)
    } finally {
      setBusy(false)
    }
  }

  if (months === null) return <div className="p-6"><Skeleton.PageHeader /><Skeleton.Table /></div>

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <PageHeader
        title="Allocate Advertising"
        subtitle="Ad-platform charges name nobody. Put a campaign — and so an artist — behind the money."
        actions={
          <div className="flex items-center gap-1">
            <button onClick={() => step(-1)} disabled={monthIdx <= 0}
              className="p-1.5 rounded-lg border border-rule disabled:opacity-30 hover:bg-gray-50"><ChevronLeft size={14} /></button>
            <select value={month} onChange={(e) => { setMonth(e.target.value); clearPreview() }}
              className="px-2 py-1.5 text-[13px] border border-rule rounded-lg bg-card">
              {(months.some((x) => x.month === month) ? months : [{ month, usd: 0 }, ...months])
                .map((m) => (
                  <option key={m.month} value={m.month}>
                    {monthLabel(m.month)}{m.usd ? ` — ${usd0(m.usd)}` : ''}
                  </option>
                ))}
            </select>
            <button onClick={() => step(1)} disabled={monthIdx < 0 || monthIdx >= months.length - 1}
              className="p-1.5 rounded-lg border border-rule disabled:opacity-30 hover:bg-gray-50"><ChevronRight size={14} /></button>
          </div>
        }
      />

      {/* The backlog, at a glance. Oldest first, and the whole point of showing it
          is that it is meant to shrink. */}
      {months.length > 1 && (
        <div className="flex items-end gap-1 mb-4 overflow-x-auto pb-1">
          {months.map((m) => {
            const max = Math.max(...months.map((x) => x.usd)) || 1
            const on = m.month === month
            return (
              <button key={m.month} onClick={() => { setMonth(m.month); clearPreview() }}
                title={`${monthLabel(m.month)} — ${usd(m.usd)} unallocated over ${m.charges} charges`}
                className="group flex-shrink-0 w-14 flex flex-col items-center gap-1">
                <span className={`text-[10px] tabular-nums ${on ? 'text-ink font-bold' : 'text-gray-400'}`}>
                  {m.usd >= 1000 ? `${Math.round(m.usd / 1000)}k` : Math.round(m.usd)}
                </span>
                <span className={`w-full rounded-t ${on ? 'bg-boom-500' : 'bg-gray-200 group-hover:bg-gray-300'}`}
                  style={{ height: `${Math.max(3, Math.round((m.usd / max) * 44))}px` }} />
                <span className={`text-[10px] ${on ? 'text-ink font-semibold' : 'text-gray-400'}`}>
                  {m.month.slice(5)}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {err && <div className="card p-3 border-l-4 border-l-rose-500 text-sm text-rose-700 mb-3">{err}</div>}
      {flash && (
        <div className="card p-3 border-l-4 border-l-emerald-500 text-sm text-emerald-800 mb-3 flex items-start gap-2">
          <span className="flex-1">{flash}</span>
          <Link to="/recoupments" className="text-[12px] font-semibold text-emerald-700 hover:underline">See it on Recoupments</Link>
          <button onClick={() => setFlash('')} className="text-emerald-400 hover:text-emerald-700">&times;</button>
        </div>
      )}

      {loading ? <Skeleton.Table /> : !data ? null : (
        <>
          {/* Three numbers, and they add up to the month. Stated rather than
              implied: a summary that does not reconcile to its own list is how
              this app has shipped a wrong total before. */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] mb-3">
            <span className="text-gray-500">
              <strong className="text-ink tabular-nums">{usd(openDollars)}</strong> unallocated
            </span>
            {blockedDollars > 0.005 && (
              <span className="text-amber-600 tabular-nums" title="In charges this page cannot restructure — listed below with the reason">
                {usd(blockedDollars)} needs sorting out by hand
              </span>
            )}
            <span className="text-gray-500">
              <strong className="text-ink tabular-nums">{usd(allocatedDollars)}</strong> allocated
            </span>
            <span className="text-gray-400">{charges.length} charges</span>
            {Math.abs((data.open_usd || 0) - (data.pool_usd || 0)) > 0.02 && (
              <span className="text-rose-600 text-[12px]" title="The listing and the P&L should agree exactly">
                listing {usd(data.open_usd)} vs report {usd(data.pool_usd)}
              </span>
            )}
          </div>

          {/* CAMPAIGNS */}
          <div className="card mb-3">
            <div className="flex items-center gap-2 px-3 py-2.5 border-b border-divider">
              <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">
                Campaigns in {monthLabel(month)}
              </span>
              <span className="ml-auto flex items-center gap-2">
                <button onClick={() => { setMode('import'); clearPreview() }}
                  className="inline-flex items-center gap-1 text-[12px] font-semibold text-boom-600 hover:text-boom-700">
                  <Upload size={12} /> Import CSV
                </button>
                <button onClick={() => setNewCamp({ name: '', platform: 'Facebook' })}
                  className="inline-flex items-center gap-1 text-[12px] font-semibold text-boom-600 hover:text-boom-700">
                  <Plus size={12} /> New campaign
                </button>
              </span>
            </div>
            {campaigns.length === 0 ? (
              <div className="px-3 py-6 text-center text-[13px] text-gray-400">
                No campaigns for this month yet. Create one — it is what gives the money a name.
              </div>
            ) : (
              <div className="divide-y divide-divider">
                {campaigns.map((c) => (
                  <div key={c.id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                    <span className="font-semibold text-gray-900">{c.artist || <span className="text-rose-500">no artist</span>}</span>
                    {c.song && <span className="text-gray-400">· {c.song}</span>}
                    <span className="text-gray-500 truncate">{c.name}</span>
                    <span className="text-[11px] text-gray-300 uppercase tracking-wide">{c.platform}</span>
                    <span className="ml-auto text-gray-400 tabular-nums">
                      {c.total_budget ? `planned ${usd0(c.total_budget)}` : ''}
                    </span>
                    <span className="w-28 text-right tabular-nums font-medium text-ink">
                      {c.allocated_cents ? usd(c.allocated_cents / 100) : <span className="text-gray-300">—</span>}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {newCamp && (
            <div className="card p-3 mb-3">
              <div className="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-2">New campaign</div>
              <NewCampaignForm month={month} busy={busy}
                onCancel={() => setNewCamp(null)} onCreate={createCampaign} />
            </div>
          )}

          {/* ALLOCATE */}
          <div className="mb-3">
            {mode === 'import' ? (
              <ImportMapper campaigns={campaigns} platform="Facebook" busy={busy}
                onCancel={() => { setMode('one'); clearPreview() }}
                onPreview={(allocations) => doPreview({ allocations, proportional: true })} />
            ) : (
              <AllocatePanel campaigns={campaigns} openDollars={openDollars} busy={busy}
                preview={preview} error={panelErr}
                onPreview={doPreview} onApply={doApply} onCancel={clearPreview} />
            )}
            {mode === 'import' && preview && (
              <div className="card p-3 mt-2">
                <div className="text-[12px] text-gray-500 mb-2">
                  <strong className="text-ink">{usd(preview.total)}</strong> of real charges, split by the
                  file's proportions across {preview.per_campaign.length} campaigns.
                </div>
                <div className="rounded-lg border border-rule overflow-hidden mb-2.5">
                  {preview.per_campaign.map((c) => (
                    <div key={c.campaign_id}
                      className="flex items-center gap-2 px-2.5 py-1.5 text-[12px] border-b border-divider/60 last:border-0">
                      <span className="font-semibold text-gray-700">{c.artist}</span>
                      {c.song && <span className="text-gray-400">· {c.song}</span>}
                      <span className="text-gray-400 truncate">{c.campaign_name}</span>
                      <span className="ml-auto tabular-nums font-medium text-ink">{usd(c.amount)}</span>
                      <span className="tabular-nums text-gray-400 w-20 text-right">{c.charges} charges</span>
                    </div>
                  ))}
                </div>
                <button onClick={doApply} disabled={busy}
                  className="btn-primary text-[13px] px-3 py-1.5 disabled:opacity-40">
                  {busy ? 'Writing…' : 'Apply — write the ledger splits'}
                </button>
                <button onClick={clearPreview} className="text-[12px] text-gray-400 hover:text-gray-600 ml-2">Cancel</button>
              </div>
            )}
          </div>

          {/* CHARGES */}
          <div className="card">
            <div className="flex items-center gap-2 px-3 py-2.5 border-b border-divider">
              <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">
                Charges — what the bank paid
              </span>
              <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-gray-400">
                <Info size={11} /> allocated slices are recoupable ledger rows
              </span>
            </div>
            <ChargeTable charges={charges}
              highlight={(preview?.per_charge || []).map((c) => c.root_id)}
              onUndo={undo} />
          </div>
        </>
      )}
    </div>
  )
}

// Inline rather than a fifth file: it is a create form for an existing endpoint
// (`POST /marketing/campaigns`), not a surface of its own.
function NewCampaignForm({ month, busy, onCancel, onCreate }) {
  const [form, setForm] = useState({ name: '', platform: 'Facebook', artist_id: '', release_id: '', total_budget: '' })
  const [artists, setArtists] = useState([])
  const [allReleases, setAllReleases] = useState([])
  useEffect(() => {
    api.get('/artists').then((r) => {
      const list = r.data?.data || r.data || []
      setArtists(Array.isArray(list) ? list : [])
    }).catch(() => {})
    // GET /releases takes no artist_id filter — passing one is silently ignored,
    // which would have listed EVERY release under whichever artist was picked. So
    // fetch once and narrow here.
    api.get('/releases').then((r) => {
      const list = r.data?.data || r.data || []
      setAllReleases(Array.isArray(list) ? list : [])
    }).catch(() => {})
  }, [])
  const releases = useMemo(
    () => (form.artist_id
      ? allReleases.filter((r) => String(r.artist_id) === String(form.artist_id))
      : []),
    [allReleases, form.artist_id])
  const set = (k) => (e) => setForm((p) => ({ ...p, [k]: e.target.value }))
  const field = 'px-2 py-1.5 text-[13px] border border-rule rounded-lg bg-card'
  return (
    <div className="flex flex-wrap items-end gap-2">
      <input value={form.name} onChange={set('name')} placeholder="Campaign name" className={`${field} w-48`} />
      <select value={form.platform} onChange={set('platform')} className={field}>
        {['Facebook', 'Instagram', 'TikTok', 'Spotify', 'YouTube', 'Google'].map((p) => <option key={p}>{p}</option>)}
      </select>
      <select value={form.artist_id} onChange={set('artist_id')} className={`${field} w-40`}>
        <option value="">Artist…</option>
        {artists.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
      <select value={form.release_id} onChange={set('release_id')} className={`${field} w-40`}
        disabled={!form.artist_id}>
        <option value="">Song (optional)…</option>
        {releases.map((r) => <option key={r.id} value={r.id}>{r.project_name || r.title || `#${r.id}`}</option>)}
      </select>
      <input value={form.total_budget} onChange={set('total_budget')} placeholder="Planned"
        inputMode="decimal" className={`${field} w-24 tabular-nums`} />
      <button onClick={() => onCreate(form)} disabled={busy || !form.name.trim() || !form.artist_id}
        className="btn-primary text-[13px] px-3 py-1.5 disabled:opacity-40">Create</button>
      <button onClick={onCancel} className="text-[12px] text-gray-400 hover:text-gray-600">Cancel</button>
      <span className="text-[11px] text-gray-400">Dated {month}-15 — the month you are allocating.</span>
    </div>
  )
}
