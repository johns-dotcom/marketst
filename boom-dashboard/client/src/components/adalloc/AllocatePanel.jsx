// Say what a campaign cost; the page works out which charges funded it.
//
// Campaign-led because that is the unit John chose, and because it is the only
// unit anybody actually knows: nothing on a Facebook charge says which campaign
// it paid for, but a person knows what a campaign was worth.
//
// ── Preview before write, always ──
// The preview is the SAME server call with dry_run: true, so what is approved is
// what gets written. A client-side estimate of a server calculation is a preview
// that can disagree with the result, and this page's whole safety story is that
// it cannot.

import { useState } from 'react'
import { ArrowRight, Loader } from 'lucide-react'

const usd = (n) => (Number(n) || 0).toLocaleString('en-US',
  { style: 'currency', currency: 'USD', minimumFractionDigits: 2 })
const day = (d) => String(d || '').slice(0, 10)

export default function AllocatePanel({
  campaigns = [], openDollars = 0, busy = false, preview = null, error = '',
  onPreview, onApply, onCancel,
}) {
  const [campaignId, setCampaignId] = useState('')
  const [amount, setAmount] = useState('')

  const camp = campaigns.find((c) => String(c.id) === String(campaignId))
  const amt = Number(String(amount).replace(/[^0-9.]/g, '')) || 0
  const canPreview = !!camp && amt > 0 && !busy

  return (
    <div className="card p-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[220px]">
          <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Campaign</label>
          <select value={campaignId} onChange={(e) => { setCampaignId(e.target.value); onCancel?.() }}
            className="w-full px-2 py-1.5 text-[13px] border border-rule rounded-lg bg-card">
            <option value="">Choose a campaign…</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.artist || 'no artist'}{c.song ? ` · ${c.song}` : ''} — {c.name}
              </option>
            ))}
          </select>
          {camp && !camp.artist && (
            <p className="text-[11px] text-rose-600 mt-1">
              This campaign has no artist, so allocating to it would attribute nothing.
            </p>
          )}
        </div>

        <div className="w-32">
          <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Spent</label>
          <input value={amount} onChange={(e) => { setAmount(e.target.value); onCancel?.() }}
            placeholder="0.00" inputMode="decimal"
            className="w-full px-2 py-1.5 text-[13px] border border-rule rounded-lg bg-card tabular-nums" />
        </div>

        <button onClick={() => onPreview?.({ campaign_id: Number(campaignId), amount: amt })}
          disabled={!canPreview}
          className="btn-primary text-[13px] px-3 py-1.5 disabled:opacity-40">
          {busy ? <Loader size={13} className="animate-spin" /> : 'Preview'}
        </button>

        <span className="text-[12px] text-gray-400 ml-auto tabular-nums">
          {usd(openDollars)} unallocated this month
          {camp?.total_budget ? ` · planned ${usd(camp.total_budget)}` : ''}
        </span>
      </div>

      {error && <div className="mt-2 text-[12px] text-rose-700 bg-rose-50 border-l-2 border-l-rose-500 px-2.5 py-1.5">{error}</div>}

      {preview && (
        <div className="mt-3 border-t border-divider pt-3">
          <div className="flex items-center gap-2 text-[12px] text-gray-500 mb-2">
            <strong className="text-ink">{usd(preview.total)}</strong>
            <span>drawn from {preview.per_charge.length} charge{preview.per_charge.length === 1 ? '' : 's'},
              oldest first</span>
            <ArrowRight size={12} className="text-gray-300" />
            <span>{usd(preview.open_after)} left unallocated</span>
          </div>
          <div className="rounded-lg border border-rule overflow-hidden">
            {preview.per_charge.map((c) => (
              <div key={c.root_id}
                className="flex items-center gap-2 px-2.5 py-1.5 text-[12px] border-b border-divider/60 last:border-0">
                <span className="text-gray-500 tabular-nums">{day(c.date)}</span>
                <span className="text-gray-700 truncate">{c.payee}</span>
                <span className="ml-auto tabular-nums text-gray-400">{usd(c.charge)}</span>
                <span className="tabular-nums font-semibold text-ink w-24 text-right">{usd(c.allocating)}</span>
                <span className="tabular-nums text-gray-400 w-24 text-right">
                  {c.whole_charge ? 'all of it' : `${usd(c.open_after)} left`}
                </span>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 mt-2.5">
            <button onClick={onApply} disabled={busy}
              className="btn-primary text-[13px] px-3 py-1.5 disabled:opacity-40">
              {busy ? 'Writing…' : 'Apply — write the ledger splits'}
            </button>
            <button onClick={onCancel} className="text-[12px] text-gray-400 hover:text-gray-600">Cancel</button>
            <span className="text-[11px] text-gray-400 ml-1">
              Each slice is marked reviewed and recoupable, so it reaches Recoupments.
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
