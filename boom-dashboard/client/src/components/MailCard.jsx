// Connected mailboxes — the Mail card on Settings › Integrations (shared
// boxes, purposes, log) and the My mailbox tab (one person's own box).
// Connecting sends the browser to Google; the server's callback brings it
// back to Settings with ?mail=connected|denied|… which this reads once.
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Mail, Plus, Send, Unplug, RefreshCw, AlertTriangle, Check } from 'lucide-react'
import api from '../api'
import { useAuth } from '../context/AuthContext'

const OUTCOME = {
  connected: (a) => ({ tone: 'ok', text: `Connected ${a || 'the mailbox'}.` }),
  denied: () => ({ tone: 'warn', text: 'Google did not grant access — nothing was connected.' }),
  badstate: () => ({ tone: 'warn', text: 'That connection attempt had expired or was not started here. Try again.' }),
  norefresh: () => ({ tone: 'warn', text: 'Google returned no refresh token. Remove the app under the Google account\'s security settings and connect again.' }),
  noemail: () => ({ tone: 'warn', text: 'Google did not say which address was signed in.' }),
  error: () => ({ tone: 'warn', text: 'The connection failed on our side; the server log has the reason.' }),
}
const ago = (ts) => (!ts ? 'never' : new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))

export function useMailboxes() {
  const [data, setData] = useState(null)
  const load = () => api.get('/mail/mailboxes').then((r) => setData({ boxes: r.data.data || [], purposes: r.data.purposes || [], configured: !!r.data.configured, redirect_uri: r.data.redirect_uri })).catch(() => setData({ boxes: [], purposes: [], configured: false }))
  useEffect(() => { load() }, [])
  return [data, load]
}

export function useMailOutcome() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [outcome, setOutcome] = useState(null)
  useEffect(() => {
    const m = searchParams.get('mail')
    if (!m) return
    setOutcome((OUTCOME[m] || OUTCOME.error)(searchParams.get('address')))
    const next = new URLSearchParams(searchParams); next.delete('mail'); next.delete('address'); setSearchParams(next, { replace: true })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return outcome
}

export function connectMailbox(kind, setErr) {
  return api.get(`/mail/connect?kind=${kind}`).then((r) => { window.location.assign(r.data.data.url) })
    .catch((e) => setErr && setErr(e?.response?.data?.error || 'Could not start the connection'))
}

function BoxRow({ box, mine, onChanged, canManage }) {
  const [busy, setBusy] = useState(''); const [note, setNote] = useState('')
  const test = async () => { setBusy('test'); setNote(''); try { const r = await api.post(`/mail/mailboxes/${box.id}/test`); setNote(r.data.data.dry_run ? 'Dry run — logged, not sent (MAIL_DRY_RUN).' : 'Test sent to you.') } catch (e) { setNote(e?.response?.data?.error || 'Test failed') } finally { setBusy(''); setTimeout(() => setNote(''), 6000) } }
  const disconnect = async () => { if (!window.confirm(`Disconnect ${box.address}? Mail routed to it stops until another mailbox takes over.`)) return; setBusy('del'); try { await api.delete(`/mail/mailboxes/${box.id}`); onChanged() } catch (e) { setNote(e?.response?.data?.error || 'Could not disconnect'); setBusy('') } }
  const bad = box.status !== 'active'
  return (
    <li className="px-4 py-3 flex items-start gap-3" data-mailbox={box.id} data-status={box.status}>
      <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${bad ? 'bg-amber-500' : 'bg-emerald-500'}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <p className="text-sm font-semibold text-gray-900">{box.address}</p>
          <span className="text-[11px] text-gray-400">{box.kind === 'personal' ? (mine ? 'yours' : 'personal') : 'shared'}{box.source === 'env' ? ' · from the server environment' : ''}</span>
          <span className={`text-[11px] font-semibold ${bad ? 'text-amber-700' : 'text-emerald-700'}`}>{bad ? 'needs reconnecting' : 'active'}</span>
        </div>
        <p className="text-xs text-gray-500">as “{box.display_name || 'market.st'}” · connected {ago(box.connected_at)}{box.connected_by_name ? ` by ${box.connected_by_name}` : ''} · last sent {ago(box.last_used_at)}</p>
        {box.last_error && <p className="text-[11px] text-amber-700 mt-0.5 flex items-center gap-1"><AlertTriangle size={11} /> {box.last_error}</p>}
        {note && <p className="text-[11px] text-gray-600 mt-1" data-box-note>{note}</p>}
      </div>
      {canManage && (
        <div className="flex items-center gap-1 flex-shrink-0">
          {bad && <button onClick={() => connectMailbox(box.kind)} className="inline-flex items-center gap-1 text-[11px] font-semibold border border-amber-300 text-amber-800 rounded-md px-2 py-1 hover:bg-amber-50" data-reconnect><RefreshCw size={11} /> Reconnect</button>}
          <button onClick={test} disabled={!!busy} className="inline-flex items-center gap-1 text-[11px] font-semibold border border-rule rounded-md px-2 py-1 hover:bg-gray-50" data-test-send><Send size={11} /> {busy === 'test' ? 'Sending…' : 'Send a test'}</button>
          <button onClick={disconnect} disabled={!!busy} className="inline-flex items-center gap-1 text-[11px] font-semibold border border-rule rounded-md px-2 py-1 hover:bg-gray-50 text-gray-600" data-disconnect><Unplug size={11} /> Disconnect</button>
        </div>
      )}
    </li>
  )
}

// The admin card: shared mailboxes, purposes, the last sends.
export default function MailCard() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'Admin' || user?.role === 'Superadmin'
  const [data, reload] = useMailboxes()
  const outcome = useMailOutcome()
  const [err, setErr] = useState('')
  const [log, setLog] = useState(null)
  const [showLog, setShowLog] = useState(false)
  useEffect(() => { if (showLog && isAdmin) api.get('/mail/log').then((r) => setLog(r.data)).catch(() => setLog({ data: [] })) }, [showLog, isAdmin])
  if (!data) return <div className="card p-4 text-sm text-gray-400">Loading mail…</div>
  const shared = data.boxes.filter((b) => b.kind === 'shared')
  const setPurpose = async (purpose, mailboxId) => { setErr(''); try { await api.put('/mail/purposes', { [purpose]: mailboxId || null }); reload() } catch (e) { setErr(e?.response?.data?.error || 'Could not save') } }
  const unassigned = data.purposes.filter((p) => !p.connected).length
  return (
    <div className="card p-4 space-y-4" data-mail-card>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2"><Mail size={15} className="text-gray-400" /> Mail</h3>
          <p className="text-xs text-gray-500 mt-0.5">Which Google address each kind of mail goes from. Send only — nothing is read.</p>
        </div>
        {isAdmin && <button onClick={() => connectMailbox('shared', setErr)} disabled={!data.configured} className="btn-primary text-xs px-3 py-1.5 inline-flex items-center gap-1.5 disabled:opacity-40" data-connect-shared title={data.configured ? '' : 'Needs GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET on Railway'}><Plus size={12} /> Connect a shared mailbox</button>}
      </div>
      {outcome && <p className={`text-xs rounded-lg border px-3 py-2 ${outcome.tone === 'ok' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-amber-50 border-amber-200 text-amber-800'}`} data-mail-outcome>{outcome.text}</p>}
      {!data.configured && <p className="text-xs rounded-lg border bg-amber-50 border-amber-200 text-amber-800 px-3 py-2" data-mail-unconfigured>The Google OAuth client is not set on the server (GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET). Until it is, mailboxes cannot be connected.</p>}
      {data.configured && data.redirect_uri && shared.length === 0 && <p className="text-[11px] text-gray-500">Before the first connection, add <code className="bg-gray-100 px-1 rounded">{data.redirect_uri}</code> to the OAuth client's authorised redirect URIs in Google Cloud.</p>}
      {err && <p className="text-xs text-rose-600" data-mail-error>{err}</p>}
      {shared.length === 0 ? (
        <p className="text-sm text-gray-500 py-2" data-no-mailboxes>No shared mailbox yet. Payment confirmations, invites and notifications wait until one is connected.</p>
      ) : (
        <ul className="divide-y divide-divider border border-rule rounded-lg" data-mailbox-list>{shared.map((b) => <BoxRow key={b.id} box={b} onChanged={reload} canManage={isAdmin} />)}</ul>
      )}
      <div data-purposes>
        <div className="flex items-baseline justify-between mb-1.5">
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Purposes</p>
          {unassigned > 0 && shared.length > 0 && <span className="text-[11px] text-amber-700">{unassigned} not assigned — that mail does not send</span>}
        </div>
        <ul className="divide-y divide-divider border border-rule rounded-lg">
          {data.purposes.map((p) => (
            <li key={p.key} className="px-4 py-2 flex items-center gap-3" data-purpose={p.key} data-connected={p.connected ? '1' : '0'}>
              <div className="flex-1 min-w-0"><p className="text-sm font-medium text-gray-900">{p.label}</p><p className="text-[11px] text-gray-500 truncate">{p.what}</p></div>
              {isAdmin ? (
                <select value={p.mailbox?.id || ''} onChange={(e) => setPurpose(p.key, e.target.value ? Number(e.target.value) : null)} className="select-base text-xs" data-purpose-select={p.key} disabled={shared.length === 0}>
                  <option value="">— not assigned</option>
                  {shared.map((b) => <option key={b.id} value={b.id}>{b.address}</option>)}
                </select>
              ) : <span className="text-xs text-gray-600">{p.mailbox?.address || 'not assigned'}</span>}
              {p.mailbox && p.mailbox.status !== 'active' && <span className="text-[11px] text-amber-700 inline-flex items-center gap-1"><AlertTriangle size={11} /> not sending</span>}
            </li>
          ))}
        </ul>
      </div>
      {isAdmin && (
        <div>
          <button onClick={() => setShowLog((v) => !v)} className="text-xs font-semibold text-boom-700 hover:underline" data-toggle-log>{showLog ? 'Hide' : 'Show'} recent sends</button>
          {showLog && (log === null ? <p className="text-xs text-gray-400 mt-2">Loading…</p> : (
            <div className="mt-2">
              <p className="text-[11px] text-gray-500 mb-1">{log.sent_24h || 0} sent in the last 24 hours. Gmail allows about 2,000 a day per mailbox. “Sent” means Gmail accepted it — bounces are not visible to a send-only connection.</p>
              {log.data.length === 0 ? <p className="text-xs text-gray-400">Nothing sent yet.</p> : (
                <ul className="divide-y divide-divider border border-rule rounded-lg max-h-72 overflow-y-auto" data-mail-log>
                  {log.data.map((r) => (
                    <li key={r.id} className="px-3 py-1.5 text-xs flex items-center gap-2">
                      <span className={`w-1.5 h-1.5 rounded-full ${r.status === 'sent' || r.status === 'dry_run' ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                      <span className="text-gray-700 truncate flex-1">{r.subject || r.kind}</span>
                      <span className="text-gray-400 truncate max-w-[180px]">→ {r.to_addr}</span>
                      <span className="text-gray-400 whitespace-nowrap">{r.address ? `from ${r.address.split('@')[0]}` : ''} · {ago(r.created_at)}</span>
                      {r.status === 'failed' && <span className="text-rose-600 truncate max-w-[200px]" title={r.error}>{r.error}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// One person's own mailbox, under My settings.
export function MyMailbox() {
  const { user } = useAuth()
  const [data, reload] = useMailboxes()
  const outcome = useMailOutcome()
  const [err, setErr] = useState('')
  if (!data) return <p className="text-sm text-gray-400">Loading…</p>
  const mine = data.boxes.find((b) => b.kind === 'personal' && Number(b.owner_user_id) === Number(user?.id))
  // The person's own address may already be connected as the LABEL's shared
  // mailbox — then it is theirs too, and "no mailbox connected" would be wrong.
  const sharedMine = !mine && data.boxes.find((b) => b.kind === 'shared' && b.status === 'active' && String(b.address || '').toLowerCase() === String(user?.email || '').toLowerCase())
  const shared = data.boxes.filter((b) => b.kind === 'shared' && b.status === 'active')
  return (
    <div className="max-w-xl space-y-4" data-my-mailbox>
      {outcome && <p className={`text-xs rounded-lg border px-3 py-2 ${outcome.tone === 'ok' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-amber-50 border-amber-200 text-amber-800'}`} data-mail-outcome>{outcome.text}</p>}
      <p className="text-sm text-gray-600">Connect your own Google address to send as yourself when you email a vendor, a creator or a teammate from the app. Automated mail (confirmations, invites, notifications) always goes from the label's shared mailboxes, never from yours.</p>
      {mine ? (
        <ul className="divide-y divide-divider border border-rule rounded-lg"><BoxRow box={mine} mine onChanged={reload} canManage /></ul>
      ) : sharedMine ? (
        <div className="card p-4 space-y-2" data-shared-is-mine>
          <p className="text-sm text-gray-900 font-semibold flex items-center gap-2"><Check size={14} className="text-emerald-600" /> {sharedMine.address} is connected — as the label's shared mailbox.</p>
          <p className="text-xs text-gray-600">Everything you send from the app already goes from your address, and automated mail does too. There is nothing more to connect; an admin manages it under Label settings › Integrations.</p>
        </div>
      ) : (
        <div className="card p-4 flex items-center justify-between gap-3 flex-wrap">
          <p className="text-sm text-gray-700">Your own address ({user?.email}) is not connected.{shared.length ? ` Mail you send goes from the label's ${shared[0].address} with replies coming back to you.` : ''}</p>
          <button onClick={() => connectMailbox('personal', setErr)} disabled={!data.configured} className="btn-primary text-xs px-3 py-1.5 inline-flex items-center gap-1.5 disabled:opacity-40" data-connect-personal title={data.configured ? '' : 'The Google OAuth client is not set on the server'}><Plus size={12} /> Connect my Google address</button>
        </div>
      )}
      {!data.configured && <p className="text-xs text-amber-800">The Google OAuth client is not configured on the server yet, so no mailbox can be connected.</p>}
      {err && <p className="text-xs text-rose-600">{err}</p>}
      <p className="text-[11px] text-gray-400 flex items-center gap-1"><Check size={11} /> Send-only permission. The app never reads your mail.</p>
    </div>
  )
}
