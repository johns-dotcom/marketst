// "Send for signature" — the button, the dialog and the status badge that
// Contracts, NDAs and Label waivers share. The dialog asks who signs (the
// counterparty; prefilled from the record) and shows who countersigns (the
// label's signer from Settings › Label). Pages whose PDF is rendered in the
// browser pass `getPdf` (returns a Blob); the server has the bytes otherwise.
import { useEffect, useState } from 'react'
import { PenLine, X, Send, RefreshCw, Ban, CheckCircle2, Clock, AlertTriangle } from 'lucide-react'
import api from '../api'

const STATUS = {
  sent: { label: 'Sent', cls: 'bg-blue-50 text-blue-700 border-blue-200', Icon: Send },
  delivered: { label: 'Signing', cls: 'bg-amber-50 text-amber-700 border-amber-200', Icon: Clock },
  completed: { label: 'Signed', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', Icon: CheckCircle2 },
  declined: { label: 'Declined', cls: 'bg-rose-50 text-rose-700 border-rose-200', Icon: Ban },
  voided: { label: 'Voided', cls: 'bg-gray-50 text-gray-500 border-gray-200', Icon: Ban },
}
export function SignatureBadge({ envelope, compact = false }) {
  if (!envelope) return null
  const s = STATUS[envelope.status] || STATUS.sent
  const who = envelope.status === 'delivered' && envelope.signer_status === 'completed' ? 'label signer' : envelope.status === 'delivered' || envelope.status === 'sent' ? envelope.signer_name : null
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full border ${s.cls} whitespace-nowrap`} title={`${s.label}${who ? ` — waiting on ${who}` : ''}${envelope.last_error ? ` · ${envelope.last_error}` : ''}`} data-signature-status={envelope.status}>
      <s.Icon size={10} /> {s.label}{!compact && who ? ` · ${who}` : ''}{envelope.last_error && <AlertTriangle size={10} className="text-amber-600" />}
    </span>
  )
}

// The latest envelope for each (doc_type, doc_id) on a page — one request.
export function useEnvelopes(docType, enabled = true) {
  const [map, setMap] = useState({})
  const load = () => { if (!enabled) return; api.get(`/docusign/envelopes?doc_type=${docType}`).then((r) => { const m = {}; for (const e of r.data.data || []) if (!m[e.doc_id]) m[e.doc_id] = e; setMap(m) }).catch(() => setMap({})) }
  useEffect(() => { load() }, [docType, enabled]) // eslint-disable-line react-hooks/exhaustive-deps
  return [map, load]
}

export function SendForSignatureButton({ docType, docId, envelope, defaults, getPdf, onChanged, title = 'Send for signature', className }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const openEnv = envelope && !['completed', 'declined', 'voided'].includes(envelope.status)
  const refresh = async (e) => { e.stopPropagation(); setBusy('r'); setErr(''); try { await api.post(`/docusign/envelopes/${envelope.id}/refresh`); onChanged && onChanged() } catch (x) { setErr(x?.response?.data?.error || 'Could not refresh') } setBusy('') }
  return (
    <span className="inline-flex items-center gap-1" data-send-for-signature={docId}>
      {envelope && <SignatureBadge envelope={envelope} compact />}
      {openEnv
        ? <button onClick={refresh} disabled={!!busy} className={className || 'p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg'} title="Check the signing status now" data-signature-refresh><RefreshCw size={14} className={busy ? 'animate-spin' : ''} /></button>
        : <button onClick={(e) => { e.stopPropagation(); setOpen(true) }} className={className || 'p-1.5 text-gray-400 hover:text-boom-700 hover:bg-boom-50 rounded-lg'} title={envelope?.status === 'completed' ? 'Signed — send again' : title} data-signature-send><PenLine size={14} /></button>}
      {err && <span className="text-[10px] text-rose-600">{err}</span>}
      {open && <SendDialog docType={docType} docId={docId} defaults={defaults} getPdf={getPdf} onClose={() => setOpen(false)} onSent={() => { setOpen(false); onChanged && onChanged() }} />}
    </span>
  )
}

export function SendDialog({ docType, docId, defaults = {}, getPdf, onClose, onSent }) {
  const [st, setSt] = useState(null)
  const [name, setName] = useState(defaults.name || '')
  const [email, setEmail] = useState(defaults.email || '')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => { api.get('/docusign/status').then((r) => setSt(r.data.data)).catch(() => setSt({ connected: false })) }, [])
  useEffect(() => { const k = (e) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k) }, [onClose])
  const signer = st?.label_signer || {}
  const canSend = st?.connected && !!signer.email && name.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  const send = async (e) => {
    e.preventDefault(); if (!canSend) return
    setBusy(true); setErr('')
    try {
      const fd = new FormData()
      fd.append('doc_type', docType); fd.append('doc_id', String(docId)); fd.append('signer_name', name.trim()); fd.append('signer_email', email.trim()); if (message.trim()) fd.append('message', message.trim())
      if (getPdf) { const blob = await getPdf(); if (blob) fd.append('file', blob, 'document.pdf') }
      await api.post('/docusign/send', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      onSent()
    } catch (x) { setErr(x?.response?.data?.error || 'Could not send') }
    setBusy(false)
  }
  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-gray-900/50 p-4" onClick={onClose} data-signature-dialog>
      <form onSubmit={send} onClick={(e) => e.stopPropagation()} className="bg-card border border-rule rounded-2xl shadow-2xl w-full max-w-md p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2"><PenLine size={15} className="text-gray-400" /> Send for signature</h3>
            <p className="text-xs text-gray-500 mt-0.5">DocuSign emails the counterparty first. When they have signed, {signer.name || 'the label signer'} countersigns. The signed PDF lands on the artist's Documents.</p>
          </div>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700 p-1 -m-1" aria-label="Close"><X size={16} /></button>
        </div>
        {st === null ? <p className="text-xs text-gray-400">Checking DocuSign…</p> : !st.connected ? (
          <p className="text-xs rounded-lg border bg-amber-50 border-amber-200 text-amber-800 px-3 py-2" data-signature-not-connected>DocuSign is not connected. An admin connects it under Settings › Integrations.</p>
        ) : !signer.email ? (
          <p className="text-xs rounded-lg border bg-amber-50 border-amber-200 text-amber-800 px-3 py-2" data-signature-no-signer>The label signer has no email yet. Set it under Settings › Label (Signatory) first.</p>
        ) : null}
        <label className="block text-xs text-gray-600 space-y-1"><span className="font-semibold text-gray-900">Who signs</span><input value={name} onChange={(e) => setName(e.target.value)} className="input-base w-full" placeholder="Full name" data-signer-name /></label>
        <label className="block text-xs text-gray-600 space-y-1"><span className="font-semibold text-gray-900">Their email</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="input-base w-full" placeholder="name@example.com" data-signer-email /></label>
        <label className="block text-xs text-gray-600 space-y-1"><span className="font-semibold text-gray-900">Message <span className="font-normal text-gray-400">optional</span></span><textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={2} className="input-base w-full" placeholder="A line for the email DocuSign sends." data-signer-message /></label>
        <p className="text-[11px] text-gray-500">Countersigner: <span className="font-semibold text-gray-700">{signer.name || '—'}</span>{signer.email ? ` · ${signer.email}` : ''}</p>
        {err && <p className="text-xs text-rose-600" data-signature-error>{err}</p>}
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="text-xs font-semibold border border-rule rounded-lg px-3 py-1.5 hover:bg-gray-50">Cancel</button>
          <button type="submit" disabled={!canSend || busy} className="btn-primary text-xs px-3 py-1.5 inline-flex items-center gap-1.5 disabled:opacity-40" data-signature-submit><Send size={12} /> {busy ? 'Sending…' : 'Send'}</button>
        </div>
      </form>
    </div>
  )
}
