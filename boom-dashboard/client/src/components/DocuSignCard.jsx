// DocuSign — the card on Settings › Integrations: connect the account, see
// what is out for signature. Sending happens on Contracts, NDAs and Waivers
// (components/SendForSignature.jsx).
import { useEffect, useState } from 'react'
import { PenLine, Unplug, RefreshCw, AlertTriangle } from 'lucide-react'
import { Link } from 'react-router-dom'
import api from '../api'
import { useOutcome } from './QuickBooksCard'
import { SignatureBadge } from './SendForSignature'

const OUTCOME = {
  connected: (a) => ({ tone: 'ok', text: `Connected DocuSign${a ? ` (${a})` : ''}. Contracts, NDAs and waivers can now be sent for signature.` }),
  denied: () => ({ tone: 'warn', text: 'DocuSign did not grant access — nothing was connected.' }),
  badstate: () => ({ tone: 'warn', text: 'That connection attempt had expired or was not started here. Try again.' }),
  error: () => ({ tone: 'warn', text: 'The connection failed on our side; the server log has the reason.' }),
}
const ago = (ts) => (!ts ? 'never' : new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))

export default function DocuSignCard() {
  const [st, setSt] = useState(null)
  const [envs, setEnvs] = useState(null)
  const [err, setErr] = useState(''); const [busy, setBusy] = useState('')
  const outcome = useOutcome('ds', OUTCOME, 'account')
  const load = () => api.get('/docusign/status').then((r) => setSt(r.data.data)).catch(() => setSt({ configured: false, connected: false }))
  useEffect(() => { load() }, [])
  useEffect(() => { if (st?.connected) api.get('/docusign/envelopes').then((r) => setEnvs(r.data.data)).catch(() => setEnvs([])) }, [st?.connected])
  if (!st) return <div className="card p-4 text-sm text-gray-400">Loading DocuSign…</div>
  const connect = () => { setErr(''); api.get('/docusign/connect').then((r) => window.location.assign(r.data.data.url)).catch((e) => setErr(e?.response?.data?.error || 'Could not start the connection')) }
  const disconnect = async () => { if (!window.confirm('Disconnect DocuSign? Envelopes already sent keep going; the dashboard stops tracking them until reconnected.')) return; setBusy('dc'); try { await api.delete('/docusign/account'); setEnvs(null); await load() } catch (e) { setErr(e?.response?.data?.error || 'Could not disconnect') } setBusy('') }
  const refresh = async (id) => { setBusy(String(id)); try { const r = await api.post(`/docusign/envelopes/${id}/refresh`); setEnvs((l) => l.map((e) => (e.id === id ? r.data.data : e))) } catch (e) { setErr(e?.response?.data?.error || 'Could not refresh') } setBusy('') }
  const signer = st.label_signer || {}
  return (
    <div className="card p-4 space-y-4" data-docusign-card data-connected={st.connected ? '1' : '0'}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2"><PenLine size={15} className="text-gray-400" /> DocuSign</h3>
          <p className="text-xs text-gray-500 mt-0.5">Send a contract, NDA or waiver for signature from its page. The counterparty signs first, then the label's signer; the signed PDF lands on the artist's Documents.</p>
        </div>
        {st.connected
          ? <button onClick={disconnect} disabled={!!busy} className="inline-flex items-center gap-1 text-[11px] font-semibold border border-rule rounded-md px-2 py-1 hover:bg-gray-50 text-gray-600" data-ds-disconnect><Unplug size={11} /> Disconnect</button>
          : <button onClick={connect} disabled={!st.configured} className="btn-primary text-xs px-3 py-1.5 inline-flex items-center gap-1.5 disabled:opacity-40" data-ds-connect title={st.configured ? '' : 'Needs DOCUSIGN_INTEGRATION_KEY and DOCUSIGN_SECRET on the server'}>Connect DocuSign</button>}
      </div>
      {outcome && <p className={`text-xs rounded-lg border px-3 py-2 ${outcome.tone === 'ok' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-amber-50 border-amber-200 text-amber-800'}`} data-ds-outcome>{outcome.text}</p>}
      {!st.configured && <p className="text-xs rounded-lg border bg-amber-50 border-amber-200 text-amber-800 px-3 py-2" data-ds-unconfigured>The DocuSign app is not set on the server (DOCUSIGN_INTEGRATION_KEY and DOCUSIGN_SECRET; DOCUSIGN_ENV=production for a live account, else the demo sandbox).</p>}
      {st.configured && !st.connected && st.redirect_uri && <p className="text-[11px] text-gray-500">Before the first connection, add <code className="bg-gray-100 px-1 rounded">{st.redirect_uri}</code> to the app's redirect URIs in the DocuSign admin.</p>}
      {err && <p className="text-xs text-rose-600" data-ds-error>{err}</p>}
      <p className="text-xs text-gray-600" data-ds-signer>Label signer: <span className="font-semibold text-gray-900">{signer.name || '—'}</span>{signer.email ? <span className="text-gray-500"> · {signer.email}</span> : <span className="text-amber-700"> · no email yet — set it under <Link to="/settings?tab=label" className="underline">Settings › Label</Link> before sending</span>}</p>
      {st.connected && (
        <>
          <div className="flex items-center gap-3 flex-wrap text-xs" data-ds-connection>
            <span className={`w-2 h-2 rounded-full ${st.status === 'active' ? 'bg-emerald-500' : 'bg-amber-500'}`} />
            <span className="font-semibold text-gray-900">{st.account_name || st.user_email}</span>
            <span className="text-gray-400">{st.env}{st.dry_run ? ' · dry run' : ''} · connected {ago(st.connected_at)} · {st.open} out for signature · {st.completed} completed</span>
            {st.status !== 'active' && <button onClick={connect} className="inline-flex items-center gap-1 text-[11px] font-semibold border border-amber-300 text-amber-800 rounded-md px-2 py-1 hover:bg-amber-50" data-ds-reconnect><RefreshCw size={11} /> Reconnect</button>}
            {st.last_error && <span className="text-amber-700 inline-flex items-center gap-1"><AlertTriangle size={11} /> {st.last_error}</span>}
          </div>
          <div>
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">Recent envelopes</p>
            {envs === null ? <p className="text-xs text-gray-400">Loading…</p> : envs.length === 0 ? <p className="text-xs text-gray-400" data-ds-empty>Nothing sent yet. Open a contract and choose Send for signature.</p> : (
              <ul className="divide-y divide-divider border border-rule rounded-lg max-h-72 overflow-y-auto" data-ds-envelopes>
                {envs.map((e) => (
                  <li key={e.id} className="px-3 py-1.5 text-xs flex items-center gap-2" data-ds-envelope={e.status}>
                    <SignatureBadge envelope={e} />
                    <span className="text-gray-900 truncate flex-1">{e.title}</span>
                    <span className="text-gray-400 truncate max-w-[200px]">→ {e.signer_email}</span>
                    <span className="text-gray-400 whitespace-nowrap">{ago(e.sent_at)}</span>
                    {!['completed', 'declined', 'voided'].includes(e.status) && <button onClick={() => refresh(e.id)} disabled={!!busy} className="inline-flex items-center gap-1 text-[11px] font-semibold border border-rule rounded-md px-1.5 py-0.5 hover:bg-gray-50" data-ds-refresh><RefreshCw size={10} className={busy === String(e.id) ? 'animate-spin' : ''} /></button>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  )
}
