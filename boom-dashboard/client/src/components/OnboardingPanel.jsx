// The signing checklist, on the artist's profile.
//
// Five steps the SERVER answers from the tables (GET /artists/:id/onboarding —
// lib/onboarding.js); nothing here is a stored tick. Each step links to the
// page that does it. Renders only for an artist who was signed through the
// pipeline (signed_at), collapses to one line once every step answers yes.
//
// The payment step is the one with work of its own: the artist's details
// arrive either through the vendor form (a link to copy or email) or typed in
// here by a bookkeeping role, through the same validators and the same
// encrypted store the form writes. Numbers typed here are never echoed back.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Check, Circle, ChevronDown, ChevronRight, Copy, Mail, KeyRound, Loader } from 'lucide-react'
import api from '../api'
import { useAuth } from '../context/AuthContext'

const PAY_ROLES = new Set(['Admin', 'Superadmin', 'Approver'])
const fmtDate = (v) => (v ? new Date(v).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }) : '')

// Mirrors server/lib/payment-fields.js FIELDS_BY_METHOD / FIELDS_BY_WIRE_SCOPE
// for RENDERING only; the server validates.
const FIELDS = {
  ACH: ['payment_account_number', 'payment_routing_number', 'payment_account_type', 'payment_holder_name', 'payment_bank_name', 'payment_bank_address'],
  'Wire·Domestic': ['payment_routing_number', 'payment_account_number', 'payment_holder_name', 'payment_bank_name', 'payment_bank_address', 'payment_beneficiary_address'],
  'Wire·International': ['payment_iban_swift', 'payment_account_number', 'payment_holder_name', 'payment_bank_name', 'payment_bank_address', 'payment_beneficiary_address', 'payment_intermediary_bank'],
  PayPal: ['payment_paypal'],
}
const LABEL = {
  payment_account_number: 'Account number', payment_routing_number: 'Routing number (ABA)', payment_account_type: 'Account type',
  payment_holder_name: 'Name on the account', payment_bank_name: 'Bank name', payment_bank_address: 'Bank address',
  payment_iban_swift: 'IBAN or SWIFT/BIC', payment_beneficiary_address: 'Beneficiary address', payment_intermediary_bank: 'Intermediary bank (optional)',
  payment_paypal: 'PayPal email or handle',
}
const OPTIONAL = new Set(['payment_intermediary_bank', 'payment_beneficiary_address'])

function TypeInPayment({ artistId, onSaved, onCancel }) {
  const [method, setMethod] = useState('ACH')
  const [scope, setScope] = useState('Domestic')
  const [vals, setVals] = useState({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const fields = FIELDS[method === 'Wire' ? `Wire·${scope}` : method]
  const submit = async (e) => {
    e.preventDefault(); setSaving(true); setError('')
    try {
      const body = { payment_method: method, ...vals }
      if (method === 'Wire') body.payment_wire_scope = scope
      const r = await api.post(`/artists/${artistId}/payment-details`, body)
      onSaved(r.data?.data)
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not save')
    } finally { setSaving(false) }
  }
  return (
    <form onSubmit={submit} className="mt-3 border border-rule rounded-lg p-3 bg-gray-50/60 space-y-2" data-typein>
      <p className="text-[11px] text-gray-500">Typed from what the artist sent. Stored encrypted, filed by the artist's email; only the last four digits are ever shown again.</p>
      <div className="grid grid-cols-2 gap-2">
        <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Method</span>
          <select value={method} onChange={(e) => { setMethod(e.target.value); setVals({}) }} className="select-base w-full mt-1">
            <option>ACH</option><option>Wire</option><option>PayPal</option>
          </select></label>
        {method === 'Wire' && (
          <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Where is the bank</span>
            <select value={scope} onChange={(e) => setScope(e.target.value)} className="select-base w-full mt-1">
              <option>Domestic</option><option>International</option>
            </select></label>
        )}
        {fields.map((k) => (
          <label key={k} className={`block ${/address/.test(k) ? 'col-span-2' : ''}`}>
            <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{LABEL[k]}</span>
            {k === 'payment_account_type' ? (
              <select value={vals[k] || ''} onChange={(e) => setVals((v) => ({ ...v, [k]: e.target.value }))} className="select-base w-full mt-1" required>
                <option value="">—</option><option>Checking</option><option>Savings</option>
              </select>
            ) : (
              <input value={vals[k] || ''} onChange={(e) => setVals((v) => ({ ...v, [k]: e.target.value }))}
                className="input-base w-full mt-1" autoComplete="off" required={!OPTIONAL.has(k) && !(method === 'Wire' && scope === 'International' && k === 'payment_account_number')} />
            )}
          </label>
        ))}
      </div>
      {error && <p className="text-[12px] text-rose-600" data-typein-error>{error}</p>}
      <div className="flex items-center gap-2">
        <button type="submit" disabled={saving} className="btn-primary text-[12px] px-3 py-1.5">{saving ? 'Saving…' : 'Save payment details'}</button>
        <button type="button" onClick={onCancel} className="text-[12px] text-gray-500 hover:text-gray-800 px-2">Cancel</button>
      </div>
    </form>
  )
}

export default function OnboardingPanel({ artistId, refreshKey = 0, onArtistChanged }) {
  const { user } = useAuth()
  const [data, setData] = useState(null)
  const [failed, setFailed] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [typing, setTyping] = useState(false)
  const [email, setEmail] = useState('')
  const [savingEmail, setSavingEmail] = useState(false)
  const [note, setNote] = useState('')

  const load = () => api.get(`/artists/${artistId}/onboarding`)
    .then((r) => { setData(r.data?.data || null); setFailed(false) })
    .catch(() => setFailed(true))
  useEffect(() => { if (artistId) load() }, [artistId, refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps

  if (failed || !data || !data.signed_at) return null
  const payment = data.steps.find((s) => s.key === 'payment')
  const canType = PAY_ROLES.has(user?.role)
  const formLink = `${window.location.origin}/submit`
  const mailto = data.email
    ? `mailto:${encodeURIComponent(data.email)}?subject=${encodeURIComponent('Payment details for market.st')}&body=${encodeURIComponent(`Hi ${data.name},\n\nSo we can pay you, please fill in your payment details and upload your W-9 here:\n${formLink}\n\nUse "${data.name}" as the payee name and this email address. There is no invoice to attach for this step — put "Advance" in the invoice number field if it asks.\n\nThanks,\nmarket.st`)}`
    : null
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(formLink); setNote('Link copied') } catch { setNote(formLink) }
    setTimeout(() => setNote(''), 3000)
  }
  const saveEmail = async (e) => {
    e.preventDefault(); if (!email.trim()) return
    setSavingEmail(true)
    try { await api.put(`/artists/${artistId}/contact`, { email: email.trim() }); setEmail(''); await load(); onArtistChanged && onArtistChanged() }
    catch (err) { setNote(err?.response?.data?.error || 'Could not save the email') }
    finally { setSavingEmail(false) }
  }

  if (data.complete) {
    return (
      <div className="card px-5 py-3" data-onboarding data-onboarding-complete>
        <button onClick={() => setExpanded((v) => !v)} className="w-full flex items-center gap-2 text-left">
          <span className="w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 inline-flex items-center justify-center"><Check size={12} /></span>
          <span className="text-sm font-semibold text-gray-900">Onboarded{data.onboarded_at ? ` on ${fmtDate(data.onboarded_at)}` : ''}</span>
          <span className="text-[11px] text-gray-400 ml-auto inline-flex items-center gap-1">{expanded ? 'hide steps' : 'show steps'} {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
        </button>
        {expanded && (
          <ul className="mt-3 space-y-1.5" data-onboarding-steps>
            {data.steps.map((s) => (
              <li key={s.key} className="flex items-center gap-2 text-[13px]"><Check size={12} className="text-emerald-600" /><span className="text-gray-700">{s.label}</span><span className="text-gray-400 text-[12px]">{s.detail}</span></li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  return (
    <div className="card px-5 py-4" data-onboarding>
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Onboarding · {data.total - data.open} of {data.total}</h3>
          <p className="text-[11px] text-gray-500">Signed {fmtDate(data.signed_at)}{data.deal?.deal_type ? ` · ${data.deal.deal_type}` : ''}. Each step ticks itself when the data exists.</p>
        </div>
        <div className="flex gap-0.5" aria-hidden>
          {data.steps.map((s) => <span key={s.key} className={`w-6 h-1.5 rounded-full ${s.done ? 'bg-emerald-500' : 'bg-gray-200'}`} />)}
        </div>
      </div>
      <ul className="divide-y divide-divider" data-onboarding-steps>
        {data.steps.map((s) => (
          <li key={s.key} className="py-2.5 flex items-start gap-3" data-step={s.key} data-done={s.done ? '1' : '0'}>
            {s.done
              ? <span className="mt-0.5 w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 inline-flex items-center justify-center flex-shrink-0"><Check size={12} /></span>
              : <Circle size={20} className="mt-0.5 text-gray-300 flex-shrink-0" strokeWidth={1.5} />}
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline justify-between gap-3">
                <p className={`text-[13px] font-semibold ${s.done ? 'text-gray-500' : 'text-gray-900'}`}>{s.label}</p>
                {s.key !== 'payment' && s.to && (
                  <Link to={s.to} data-step-link className="text-[12px] text-boom-600 hover:underline whitespace-nowrap">{s.to_label || 'Open'}</Link>
                )}
              </div>
              <p className="text-[12px] text-gray-500">{s.detail}</p>
              {s.key === 'payment' && !s.done && (
                <div className="mt-2">
                  {!data.email ? (
                    <form onSubmit={saveEmail} className="flex items-center gap-2" data-add-email>
                      <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="artist@email.com" className="input-base text-[12px] py-1 w-56" required />
                      <button type="submit" disabled={savingEmail} className="btn-primary text-[12px] px-3 py-1">{savingEmail ? 'Saving…' : 'Save email'}</button>
                    </form>
                  ) : (
                    <div className="flex items-center gap-2 flex-wrap">
                      <button type="button" onClick={copyLink} className="inline-flex items-center gap-1 text-[12px] font-medium border border-rule rounded-md px-2.5 py-1 hover:bg-gray-50" data-copy-link><Copy size={12} /> Copy the form link</button>
                      {mailto && <a href={mailto} className="inline-flex items-center gap-1 text-[12px] font-medium border border-rule rounded-md px-2.5 py-1 hover:bg-gray-50" data-mail-link><Mail size={12} /> Email it to {data.email}</a>}
                      {canType && !typing && <button type="button" onClick={() => setTyping(true)} className="inline-flex items-center gap-1 text-[12px] font-medium border border-rule rounded-md px-2.5 py-1 hover:bg-gray-50" data-type-in><KeyRound size={12} /> Type in</button>}
                      {note && <span className="text-[11px] text-gray-500" data-note>{note}</span>}
                    </div>
                  )}
                  {typing && <TypeInPayment artistId={artistId} onCancel={() => setTyping(false)} onSaved={() => { setTyping(false); setNote('Payment details saved'); load() }} />}
                  {payment && !payment.w9 && payment.on_file && <p className="text-[11px] text-amber-700 mt-1.5">Details are on file; the W-9 is still missing. It arrives with the form, or attach it to the advance invoice under Payments.</p>}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
