// The pipeline as numbers: how many prospects reached each stage, how long a
// stage takes, and who and what converts. Built from the stage history, so a
// deal that went Scouting → Offer → Passed still counts as having reached Offer.
// CSS bars, one axis, no library — the reader wants the count and the
// percentage, not a chart to decode.
import { useEffect, useState } from 'react'
import api from '../../api'
import { fmtMoneyFull } from '../../lib/deals'

const RANGES = [
  ['all', 'All time', () => ({})],
  ['year', 'This year', () => ({ from: `${new Date().getFullYear()}-01-01` })],
  ['90', 'Last 90 days', () => { const d = new Date(Date.now() - 90 * 86400000); return { from: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` } }],
]
const pct = (v) => (v === null || v === undefined ? '—' : `${v}%`)

export default function DealFunnel() {
  const [range, setRange] = useState('all')
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    let live = true
    const q = RANGES.find((r) => r[0] === range)[2]()
    setData(null); setErr('')
    api.get('/deals/report/funnel', { params: q }).then((r) => { if (live) setData(r.data?.data || null) }).catch(() => { if (live) setErr('Could not load the report') })
    return () => { live = false }
  }, [range])

  const max = data ? Math.max(1, ...data.funnel.map((f) => f.reached)) : 1
  const Table = ({ title, rows, keyLabel, testId }) => (
    <div className="bg-card border border-rule rounded-xl p-4" data-funnel-table={testId}>
      <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">{title}</p>
      {rows.length === 0 ? <p className="text-xs text-gray-400">Nothing yet.</p> : (
        <table className="w-full text-xs">
          <thead><tr className="text-[10px] uppercase tracking-wider text-gray-400"><th className="text-left py-1">{keyLabel}</th><th className="text-right py-1">Open</th><th className="text-right py-1">Signed</th><th className="text-right py-1">Passed</th><th className="text-right py-1">Win rate</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.key} className="border-t border-divider"><td className="py-1.5 text-gray-800">{r.key}</td><td className="py-1.5 text-right tabular-nums text-gray-600">{r.open}</td><td className="py-1.5 text-right tabular-nums text-emerald-700">{r.signed}</td><td className="py-1.5 text-right tabular-nums text-gray-500">{r.passed}</td><td className="py-1.5 text-right tabular-nums font-semibold text-gray-800">{pct(r.win_rate)}</td></tr>
          ))}</tbody>
        </table>
      )}
    </div>
  )

  return (
    <div className="space-y-4" data-deal-funnel>
      <div className="flex items-center gap-1.5 flex-wrap">
        {RANGES.map(([id, label]) => (
          <button key={id} type="button" onClick={() => setRange(id)} data-funnel-range={id}
            className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${range === id ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>{label}</button>
        ))}
        <span className="text-[11px] text-gray-400 ml-2">by the date a deal was added</span>
      </div>
      {err && <p className="text-sm text-rose-600">{err}</p>}
      {!data && !err && <p className="text-sm text-gray-400">Loading…</p>}
      {data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3" data-funnel-totals>
            {[['Live deals', data.totals.live, fmtMoneyFull(data.totals.live_advance) + ' in advances'], ['Signed', data.totals.signed, fmtMoneyFull(data.totals.signed_advance) + ' in advances'], ['Passed', data.totals.passed, data.passed_reasons[0] ? `most often: ${data.passed_reasons[0].reason}` : ''], ['Win rate', pct(data.totals.win_rate), 'signed ÷ (signed + passed)']].map(([label, n, sub]) => (
              <div key={label} className="bg-card border border-rule rounded-xl p-4"><p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">{label}</p><p className="text-2xl font-semibold text-gray-900 mt-1 tabular-nums">{n}</p>{sub && <p className="text-[11px] text-gray-400 mt-0.5">{sub}</p>}</div>
            ))}
          </div>
          <div className="bg-card border border-rule rounded-xl p-4" data-funnel-stages>
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-3">Reached each stage · conversion from the stage before</p>
            <ol className="space-y-2">
              {data.funnel.map((f) => (
                <li key={f.stage} className="grid grid-cols-[7rem_1fr_6rem] items-center gap-3 text-xs" data-funnel-stage={f.stage} data-reached={f.reached}>
                  <span className="text-gray-700 font-medium">{f.stage}</span>
                  <div className="h-5 bg-gray-100 rounded overflow-hidden"><div className="h-full bg-boom-500/70 rounded" style={{ width: `${Math.round((f.reached / max) * 100)}%` }} /></div>
                  <span className="text-right tabular-nums text-gray-700"><span className="font-semibold">{f.reached}</span>{f.conversion !== null && <span className="text-gray-400"> · {f.conversion}%</span>}</span>
                </li>
              ))}
            </ol>
          </div>
          <div className="bg-card border border-rule rounded-xl p-4" data-funnel-days>
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Days in each stage · completed stints, and how many sit there now</p>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {data.stage_days.map((s) => (
                <div key={s.stage} data-stage-days={s.stage}><p className="text-xs text-gray-500">{s.stage}</p><p className="text-lg font-semibold text-gray-900 tabular-nums">{s.avg_days === null ? '—' : `${s.avg_days}d`}</p><p className="text-[11px] text-gray-400">{s.completed} moved on{s.sitting ? ` · ${s.sitting} sitting` : ''}</p></div>
              ))}
            </div>
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            <Table title="By source" rows={data.by_source} keyLabel="Source" testId="source" />
            <Table title="By owner" rows={data.by_owner} keyLabel="Owner" testId="owner" />
          </div>
          {data.passed_reasons.length > 0 && (
            <div className="bg-card border border-rule rounded-xl p-4" data-funnel-reasons>
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Why we passed</p>
              <div className="flex flex-wrap gap-2">{data.passed_reasons.map((r) => <span key={r.reason} className="text-xs bg-gray-100 text-gray-700 rounded-full px-2.5 py-1">{r.reason} · <span className="font-semibold tabular-nums">{r.n}</span></span>)}</div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
