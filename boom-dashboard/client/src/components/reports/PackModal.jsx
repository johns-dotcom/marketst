import { useEffect, useState } from 'react'
import { X, Download, Send, Loader, Mail } from 'lucide-react'
import api from '../../api'
import { BASIS_TEXT } from './BasisSwitch'

// The accountant pack (2026-09-20): one workbook — cover, P&L, balance sheet,
// spend by artist / vendor / rep, dismissed — downloaded now for the range on
// screen, or sent by email on a day of the month for the previous calendar
// month (lib/notifier accountant_pack, settings in report_pack_settings).
export default function PackModal({ open, onClose, from, to, basis }) {
  const [s, setS] = useState(null)
  const [saving, setSaving] = useState(false)
  const [sending, setSending] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [msg, setMsg] = useState(null)
  useEffect(() => {
    if (!open) return
    setMsg(null)
    api.get('/reports/pack/settings').then((r) => setS(r.data?.data || {})).catch((e) => setMsg({ err: e.response?.data?.error || e.message }))
  }, [open])
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null

  const save = async (patch) => {
    setSaving(true); setMsg(null)
    try { const r = await api.put('/reports/pack/settings', { ...s, ...patch }); setS((prev) => ({ ...prev, ...r.data.data })); setMsg({ ok: 'Saved.' }) }
    catch (e) { setMsg({ err: e.response?.data?.error || e.message }) }
    finally { setSaving(false) }
  }
  const download = async () => {
    setDownloading(true); setMsg(null)
    try {
      const res = await api.get(`/reports/pack.xlsx?from=${from}&to=${to}&basis=${basis}`, { responseType: 'blob' })
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([res.data])); a.download = `marketst-accountant-pack-${from}-to-${to}.xlsx`
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href)
    } catch (e) { setMsg({ err: e.response?.data?.error || e.message }) }
    finally { setDownloading(false) }
  }
  const sendNow = async () => {
    setSending(true); setMsg(null)
    try {
      const r = await api.post('/reports/pack/send', { from, to, basis, recipients: s?.recipients })
      setMsg({ ok: `Sent to ${r.data.data.sent_to.join(', ')} — ${r.data.data.filename}` })
    } catch (e) { setMsg({ err: e.response?.data?.error || e.message }) }
    finally { setSending(false) }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-card rounded-2xl shadow-2xl w-full max-w-lg p-6" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Accountant pack" data-pack-modal>
        <div className="flex items-start justify-between gap-3 mb-1">
          <h3 className="text-base font-bold text-ink">Accountant pack</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-ink" aria-label="Close"><X size={16} /></button>
        </div>
        <p className="text-[12px] text-gray-500 mb-4">One workbook: a cover stating the period, basis and what was excluded, then the P&L, balance sheet as of the range end, spend by artist, vendor and rep, and every dismissed item.</p>

        <div className="rounded-xl border border-rule p-3 mb-4">
          <p className="text-[11px] font-bold uppercase tracking-wider text-gray-400 mb-1">This range, now</p>
          <p className="text-[12.5px] text-ink mb-2">{from} → {to} · {BASIS_TEXT[basis]?.label}</p>
          <div className="flex flex-wrap gap-2">
            <button onClick={download} disabled={downloading} className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 text-white px-3 py-1.5 text-[12px] font-bold disabled:opacity-40" data-pack-download>
              {downloading ? <Loader size={12} className="animate-spin" /> : <Download size={12} />} Download
            </button>
            <button onClick={sendNow} disabled={sending || !s?.recipients} title={!s?.recipients ? 'Add recipients below first' : 'Email this range to the recipients below'} className="inline-flex items-center gap-1.5 rounded-lg border border-rule px-3 py-1.5 text-[12px] font-bold text-ink disabled:opacity-40" data-pack-send>
              {sending ? <Loader size={12} className="animate-spin" /> : <Send size={12} />} Send now
            </button>
          </div>
        </div>

        <div className="rounded-xl border border-rule p-3">
          <p className="text-[11px] font-bold uppercase tracking-wider text-gray-400 mb-2">Every month, by email</p>
          {!s ? <p className="text-[12px] text-gray-400">Loading…</p> : (
            <div className="space-y-2 text-[12.5px]">
              <label className="block">
                <span className="text-gray-500">Recipients</span>
                <input value={s.recipients || ''} onChange={(e) => setS({ ...s, recipients: e.target.value })} onBlur={() => save({ recipients: s.recipients })} placeholder="accountant@firm.com, you@label.com" className="mt-0.5 w-full border border-rule rounded-lg px-2 py-1.5 bg-card text-ink" data-pack-recipients />
              </label>
              <div className="flex flex-wrap items-center gap-3">
                <label className="inline-flex items-center gap-1.5 text-gray-500">Day of month
                  <input type="number" min={1} max={28} value={s.day || 5} onChange={(e) => setS({ ...s, day: Number(e.target.value) })} onBlur={() => save({ day: s.day })} className="w-16 border border-rule rounded-lg px-2 py-1 bg-card text-ink" data-pack-day />
                </label>
                <label className="inline-flex items-center gap-1.5 text-gray-500">Basis
                  <select value={s.basis || 'bank'} onChange={(e) => { setS({ ...s, basis: e.target.value }); save({ basis: e.target.value }) }} className="border border-rule rounded-lg px-2 py-1 bg-card text-ink" data-pack-basis>
                    {Object.entries(BASIS_TEXT).map(([k, b]) => <option key={k} value={k}>{b.label}</option>)}
                  </select>
                </label>
                <label className="inline-flex items-center gap-1.5 font-semibold text-ink ml-auto">
                  <input type="checkbox" checked={!!s.enabled} onChange={(e) => save({ enabled: e.target.checked })} data-pack-enabled /> On
                </label>
              </div>
              <p className="text-[11px] text-gray-400 inline-flex items-center gap-1.5"><Mail size={11} />
                {s.enabled ? `Sends the previous calendar month on the ${s.day}${s.day === 1 ? 'st' : s.day === 2 ? 'nd' : s.day === 3 ? 'rd' : 'th'}, from the label's Team mailbox.` : 'Off. Turn it on to send the previous month automatically.'}
                {s.last_sent_period ? ` Last sent: ${s.last_sent_period}.` : ''}
                {s.last_error ? ` Last attempt failed: ${s.last_error}` : ''}
              </p>
            </div>
          )}
        </div>
        {msg?.ok && <p className="mt-3 text-[12px] text-emerald-600 font-semibold" data-pack-ok>{msg.ok}</p>}
        {msg?.err && <p className="mt-3 text-[12px] text-rose-600 font-semibold" data-pack-err>{msg.err}</p>}
        {saving && <p className="mt-2 text-[11px] text-gray-400">Saving…</p>}
      </div>
    </div>
  )
}
