// QuickBooks Online — the card on Settings › Integrations. Connect (Intuit
// consent, back via ?qb=…), map the ledger's categories to QuickBooks
// accounts, pick the bank account payments come from, watch the push queue.
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { BookOpen, RefreshCw, Unplug, AlertTriangle, RotateCcw, Check } from 'lucide-react'
import api from '../api'

const OUTCOME = {
  connected: (c) => ({ tone: 'ok', text: `Connected QuickBooks${c ? ` for ${c}` : ''}. Now map categories to accounts and pick the bank account below.` }),
  denied: () => ({ tone: 'warn', text: 'Intuit did not grant access — nothing was connected.' }),
  badstate: () => ({ tone: 'warn', text: 'That connection attempt had expired or was not started here. Try again.' }),
  error: () => ({ tone: 'warn', text: 'The connection failed on our side; the server log has the reason.' }),
}
const ago = (ts) => (!ts ? 'never' : new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))
const money = (n) => (n == null ? '' : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' }))

export function useOutcome(param, table, extra) {
  const [searchParams, setSearchParams] = useSearchParams()
  const [outcome, setOutcome] = useState(null)
  useEffect(() => {
    const m = searchParams.get(param); if (!m) return
    setOutcome((table[m] || table.error)(extra ? searchParams.get(extra) : undefined))
    const next = new URLSearchParams(searchParams); next.delete(param); if (extra) next.delete(extra); setSearchParams(next, { replace: true })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return outcome
}

function AccountSelect({ value, options, onChange, placeholder, testid }) {
  return (
    <select value={value?.id || ''} onChange={(e) => onChange(options.find((o) => o.id === e.target.value) || null)} className="select-base text-xs" data-qb-select={testid}>
      <option value="">{placeholder}</option>
      {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
    </select>
  )
}

export default function QuickBooksCard() {
  const [st, setSt] = useState(null)
  const [accounts, setAccounts] = useState(null)
  const [categories, setCategories] = useState(null)
  const [queue, setQueue] = useState(null)
  const [err, setErr] = useState(''); const [note, setNote] = useState(''); const [busy, setBusy] = useState('')
  const [showMap, setShowMap] = useState(false)
  const outcome = useOutcome('qb', OUTCOME, 'company')
  const load = () => api.get('/quickbooks/status').then((r) => setSt(r.data.data)).catch(() => setSt({ configured: false, connected: false, queue: {} }))
  useEffect(() => { load() }, [])
  useEffect(() => {
    if (!st?.connected) return
    api.get('/quickbooks/queue?limit=25').then((r) => setQueue(r.data.data)).catch(() => setQueue([]))
    if (showMap && !accounts) {
      api.get('/quickbooks/accounts').then((r) => setAccounts(r.data.data)).catch((e) => { setAccounts({ expense: [], bank: [], ap: [] }); setErr(e?.response?.data?.error || 'Could not read the accounts from QuickBooks') })
      api.get('/quickbooks/categories').then((r) => setCategories(r.data.data)).catch(() => setCategories([]))
    }
  }, [st?.connected, showMap]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!st) return <div className="card p-4 text-sm text-gray-400">Loading QuickBooks…</div>
  const connect = () => { setErr(''); api.get('/quickbooks/connect').then((r) => window.location.assign(r.data.data.url)).catch((e) => setErr(e?.response?.data?.error || 'Could not start the connection')) }
  const disconnect = async () => { if (!window.confirm('Disconnect QuickBooks? Approvals and payments stop syncing until it is connected again.')) return; setBusy('dc'); try { await api.delete('/quickbooks/connection'); setQueue(null); await load() } catch (e) { setErr(e?.response?.data?.error || 'Could not disconnect') } setBusy('') }
  const save = async (patch) => { setErr(''); try { const r = await api.put('/quickbooks/settings', patch); setSt((s) => ({ ...s, settings: r.data.data })) } catch (e) { setErr(e?.response?.data?.error || 'Could not save') } }
  const sync = async () => { setBusy('sync'); setNote(''); try { const r = await api.post('/quickbooks/sync'); const d = r.data.data; setNote(`Pushed ${d.done}, failed ${d.failed}.`); await load(); api.get('/quickbooks/queue?limit=25').then((q) => setQueue(q.data.data)) } catch (e) { setErr(e?.response?.data?.error || 'Sync failed') } setBusy('') }
  const retry = async (id) => { try { await api.post(`/quickbooks/queue/${id}/retry`); await sync() } catch (e) { setErr(e?.response?.data?.error || 'Could not retry') } }
  const s = st.settings || {}
  const unmapped = categories ? categories.filter((c) => !(s.category_map || {})[c]) : []
  const ready = !!s.bank_account && (!!s.default_expense_account || unmapped.length === 0)
  return (
    <div className="card p-4 space-y-4" data-quickbooks-card data-connected={st.connected ? '1' : '0'}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2"><BookOpen size={15} className="text-gray-400" /> QuickBooks Online</h3>
          <p className="text-xs text-gray-500 mt-0.5">Approving an invoice creates the Bill; marking it paid creates the BillPayment. Vendors are matched by name or created. Pushes retry on their own.</p>
        </div>
        {st.connected
          ? <button onClick={disconnect} disabled={!!busy} className="inline-flex items-center gap-1 text-[11px] font-semibold border border-rule rounded-md px-2 py-1 hover:bg-gray-50 text-gray-600" data-qb-disconnect><Unplug size={11} /> Disconnect</button>
          : <button onClick={connect} disabled={!st.configured} className="btn-primary text-xs px-3 py-1.5 inline-flex items-center gap-1.5 disabled:opacity-40" data-qb-connect title={st.configured ? '' : 'Needs QBO_CLIENT_ID and QBO_CLIENT_SECRET on the server'}>Connect QuickBooks</button>}
      </div>
      {outcome && <p className={`text-xs rounded-lg border px-3 py-2 ${outcome.tone === 'ok' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-amber-50 border-amber-200 text-amber-800'}`} data-qb-outcome>{outcome.text}</p>}
      {!st.configured && <p className="text-xs rounded-lg border bg-amber-50 border-amber-200 text-amber-800 px-3 py-2" data-qb-unconfigured>The Intuit app is not set on the server (QBO_CLIENT_ID and QBO_CLIENT_SECRET; QBO_ENV=production for a live company, else the sandbox). Until it is, nothing can be connected.</p>}
      {st.configured && !st.connected && st.redirect_uri && <p className="text-[11px] text-gray-500">Before the first connection, add <code className="bg-gray-100 px-1 rounded">{st.redirect_uri}</code> to the Intuit app's redirect URIs.</p>}
      {err && <p className="text-xs text-rose-600" data-qb-error>{err}</p>}
      {st.connected && (
        <>
          <div className="flex items-center gap-3 flex-wrap text-xs" data-qb-connection>
            <span className={`w-2 h-2 rounded-full ${st.status === 'active' ? 'bg-emerald-500' : 'bg-amber-500'}`} />
            <span className="font-semibold text-gray-900">{st.company_name || `Company ${st.realm_id}`}</span>
            <span className="text-gray-400">{st.env}{st.dry_run ? ' · dry run' : ''} · connected {ago(st.connected_at)} · last push {ago(st.last_synced_at)}</span>
            {st.status !== 'active' && <button onClick={connect} className="inline-flex items-center gap-1 text-[11px] font-semibold border border-amber-300 text-amber-800 rounded-md px-2 py-1 hover:bg-amber-50" data-qb-reconnect><RefreshCw size={11} /> Reconnect</button>}
            {st.last_error && <span className="text-amber-700 inline-flex items-center gap-1"><AlertTriangle size={11} /> {st.last_error}</span>}
          </div>
          {!ready && <p className="text-xs rounded-lg border bg-amber-50 border-amber-200 text-amber-800 px-3 py-2" data-qb-not-ready>Not pushing yet: {!s.bank_account ? 'pick the bank account payments come from' : ''}{!s.bank_account && (!s.default_expense_account && unmapped.length) ? ' and ' : ''}{!s.default_expense_account && unmapped.length ? `map ${unmapped.length} categor${unmapped.length === 1 ? 'y' : 'ies'} or set a default expense account` : ''}.</p>}
          <div>
            <button onClick={() => setShowMap((v) => !v)} className="text-xs font-semibold text-boom-700 hover:underline" data-qb-toggle-map>{showMap ? 'Hide' : 'Show'} accounts and category mapping</button>
            {showMap && (!accounts || !categories ? <p className="text-xs text-gray-400 mt-2">Reading accounts from QuickBooks…</p> : (
              <div className="mt-2 space-y-3" data-qb-mapping>
                <div className="grid sm:grid-cols-2 gap-3">
                  <label className="text-xs text-gray-600 space-y-1"><span className="font-semibold text-gray-900">Bank account for payments</span><AccountSelect value={s.bank_account} options={accounts.bank} onChange={(v) => save({ bank_account: v })} placeholder="— choose" testid="bank" /></label>
                  <label className="text-xs text-gray-600 space-y-1"><span className="font-semibold text-gray-900">Default expense account</span><AccountSelect value={s.default_expense_account} options={accounts.expense} onChange={(v) => save({ default_expense_account: v })} placeholder="— none (every category must be mapped)" testid="default" /></label>
                </div>
                <div>
                  <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Categories → QuickBooks accounts</p>
                  {categories.length === 0 ? <p className="text-xs text-gray-400">No expense categories yet.</p> : (
                    <ul className="divide-y divide-divider border border-rule rounded-lg max-h-80 overflow-y-auto">
                      {categories.map((c) => (
                        <li key={c} className="px-3 py-1.5 flex items-center gap-3" data-qb-category={c}>
                          <span className="text-xs text-gray-900 flex-1 truncate">{c}</span>
                          <AccountSelect value={(s.category_map || {})[c]} options={accounts.expense} onChange={(v) => save({ category_map: { ...(s.category_map || {}), [c]: v || undefined } })} placeholder={s.default_expense_account ? `default · ${s.default_expense_account.name}` : '— not mapped'} testid={`cat-${c}`} />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div>
            <div className="flex items-baseline justify-between mb-1.5 gap-2 flex-wrap">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Push queue · {st.queue.pending || 0} waiting · {st.queue.error || 0} failed · {st.queue.done || 0} done</p>
              <div className="flex items-center gap-2">
                {note && <span className="text-[11px] text-gray-600" data-qb-note>{note}</span>}
                <button onClick={sync} disabled={!!busy} className="inline-flex items-center gap-1 text-[11px] font-semibold border border-rule rounded-md px-2 py-1 hover:bg-gray-50" data-qb-sync><RefreshCw size={11} className={busy === 'sync' ? 'animate-spin' : ''} /> Sync now</button>
              </div>
            </div>
            {queue === null ? <p className="text-xs text-gray-400">Loading…</p> : queue.length === 0 ? <p className="text-xs text-gray-400" data-qb-queue-empty>Nothing queued yet. The next approval will appear here.</p> : (
              <ul className="divide-y divide-divider border border-rule rounded-lg max-h-72 overflow-y-auto" data-qb-queue>
                {queue.map((r) => (
                  <li key={r.id} className="px-3 py-1.5 text-xs flex items-center gap-2" data-qb-row={r.status}>
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${r.status === 'done' ? 'bg-emerald-500' : r.status === 'error' ? 'bg-rose-500' : 'bg-amber-400'}`} />
                    <span className="text-gray-500 w-14 flex-shrink-0">{r.kind === 'payment' ? 'Payment' : 'Bill'}</span>
                    <span className="text-gray-900 truncate flex-1">{r.payee || `#${r.expense_id}`}{r.invoice_number ? ` · ${r.invoice_number}` : ''}</span>
                    <span className="text-gray-500 whitespace-nowrap">{money(r.amount)}</span>
                    {r.status === 'done' && <span className="text-emerald-700 inline-flex items-center gap-1"><Check size={11} /> QB #{r.qbo_id}</span>}
                    {r.status === 'pending' && <span className="text-gray-400 whitespace-nowrap">{r.attempts ? `retry ${ago(r.next_attempt_at)}` : 'waiting'}</span>}
                    {r.status === 'error' && <><span className="text-rose-600 truncate max-w-[260px]" title={r.last_error}>{r.last_error}</span><button onClick={() => retry(r.id)} className="inline-flex items-center gap-1 text-[11px] font-semibold border border-rule rounded-md px-1.5 py-0.5 hover:bg-gray-50" data-qb-retry><RotateCcw size={10} /> Retry</button></>}
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
