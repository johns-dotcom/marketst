import { useState, useEffect, useRef } from 'react'
import { Loader, Send, X } from 'lucide-react'
import api from '../api'
import { useTheme } from '../context/ThemeContext'
import getDarkColors from '../utils/darkColors'
import CcChipInput from './CcChipInput'

// Generic email preview + edit modal. Used by every "send email" flow across
// the app so admins get a chance to review and tweak before mail goes out.
//
// Two ways to drive it:
//   1) Pre-rendered: pass `initialHtml` + `initialSubject` + `initialTo`/`initialCc`.
//      Used by action endpoints that return a pending_email payload directly.
//   2) Lazy preview: pass `previewKind` + `previewContext` and the modal
//      fetches POST /api/email/preview itself when it opens.
//
// On Send: posts to /api/email/send with kind, context, the edited fields,
// and (when the preview was inline-edited) html_override. Returns success.
//
// Props:
//   • open                — visibility
//   • onClose             — close handler (also bound to Cancel + backdrop)
//   • onSent              — fires after a successful send
//   • onSkipped           — optional, fires when user clicks "Skip email"
//   • title / subtitle    — header text
//   • previewKind         — e.g. 'vendor_approved', 'welcome', 'task_assigned'
//   • previewContext      — JSON-serializable context the server uses to render
//   • initialTo / Cc / Subject / Html  — when provided, modal skips the fetch
//   • showMessageField    — when true, surfaces a "Personal Note" textarea
//                           whose value is sent as `message` (server templates
//                           that support a personal-note slot use this)
//   • sendLabel / skipLabel  — button text overrides
//   • team                — array of {name,email} for CC autocomplete
//   • defaultCcEmails     — array of strings; pre-fills the CC chip list
export default function EmailPreviewModal({
  open, onClose, onSent, onSkipped,
  title = 'Send email', subtitle,
  previewKind, previewContext,
  initialTo, initialCc, initialSubject, initialHtml, initialMessage,
  showMessageField = false,
  sendLabel = 'Send', skipLabel = 'Skip email',
  team = [], defaultCcEmails = [],
  attachmentLabels,
  customSend,
}) {
  // From (2026-09-19): the purpose's shared mailbox, or the sender's own if
  // they connected one under My settings › My mailbox.
  const [fromOptions, setFromOptions] = useState(null)
  const [fromMailboxId, setFromMailboxId] = useState('')
  useEffect(() => {
    if (!open) return
    api.get('/mail/mailboxes').then((r) => {
      const boxes = r.data?.data || []
      const mine = boxes.find((b) => b.kind === 'personal' && b.status === 'active')
      const purposeKey = { payment_confirmation: 'payments', bulk_payment_confirmation: 'payments', vendor_approved: 'vendors', vendor_rejected: 'vendors' }[previewKind] || 'team'
      const shared = (r.data?.purposes || []).find((p) => p.key === purposeKey)?.mailbox || null
      setFromOptions({ shared, mine })
    }).catch(() => setFromOptions({ shared: null, mine: null }))
  }, [open, previewKind])
  const { theme } = useTheme()
  const C = getDarkColors(theme)
  const inputSty = {
    background: C.inputBg, border: '1.5px solid ' + C.inputBorder, borderRadius: 8,
    padding: '7px 10px', color: C.text, fontSize: 13, fontFamily: 'inherit', outline: 'none',
  }

  const [form, setForm] = useState({ to: '', cc: '', subject: '', message: '' })
  const [html, setHtml] = useState('')
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [skipping, setSkipping] = useState(false)
  const [previewEdited, setPreviewEdited] = useState(false)
  const iframeRef = useRef(null)

  const parseCcList = (s) => !s ? [] : String(s).split(/[,;\n]/).map(p => p.trim()).filter(Boolean)
  const joinCcList = (arr) => (arr || []).filter(Boolean).join(', ')
  const dedupeCi = (arr) => {
    const seen = new Set(); const out = []
    for (const v of arr || []) {
      const k = String(v || '').toLowerCase().trim()
      if (!k || seen.has(k)) continue
      seen.add(k); out.push(v)
    }
    return out
  }

  // Hydrate on open. Either trust the inline payload or fetch the preview.
  useEffect(() => {
    if (!open) return
    setPreviewEdited(false)
    if (initialHtml || initialSubject || initialTo) {
      const baseCc = parseCcList(initialCc)
      const merged = dedupeCi([...baseCc, ...defaultCcEmails])
        .filter(e => e.toLowerCase() !== String(initialTo || '').toLowerCase())
      setForm({
        to: initialTo || '',
        cc: joinCcList(merged),
        subject: initialSubject || '',
        message: initialMessage || '',
      })
      setHtml(initialHtml || '')
      return
    }
    if (!previewKind) return
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        const r = await api.post('/email/preview', { kind: previewKind, context: previewContext || {} })
        if (cancelled) return
        const d = r.data?.data || {}
        const baseCc = parseCcList(d.cc)
        const merged = dedupeCi([...baseCc, ...defaultCcEmails])
          .filter(e => e.toLowerCase() !== String(d.to || '').toLowerCase())
        setForm({
          to: d.to || '',
          cc: joinCcList(merged),
          subject: d.subject || '',
          message: initialMessage || '',
        })
        setHtml(d.html || '')
      } catch (err) {
        // Stay open with empty state; user can still cancel out cleanly.
        console.warn('email preview fetch failed', err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, previewKind, JSON.stringify(previewContext), initialHtml, initialTo, initialCc, initialSubject])

  // Re-render preview when the message textarea changes — server templates
  // that support a personalMessage slot render that as a paragraph inside the
  // preview HTML. Skipped after the user has hand-edited the iframe (the
  // re-fetch would clobber their edits).
  useEffect(() => {
    if (!open || !previewKind || previewEdited) return
    const id = setTimeout(async () => {
      try {
        const r = await api.post('/email/preview', {
          kind: previewKind,
          context: previewContext || {},
          to: form.to, cc: form.cc, subject: form.subject, message: form.message,
        })
        const d = r.data?.data || {}
        setHtml(d.html || '')
      } catch { /* keep previous */ }
    }, 350)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.message, open, previewKind, previewEdited])

  // Wire the iframe body up for inline editing on every srcDoc load.
  const handleIframeLoad = () => {
    const ifr = iframeRef.current
    if (!ifr) return
    let doc
    try { doc = ifr.contentDocument } catch { return }
    if (!doc || !doc.body) return
    doc.body.contentEditable = 'true'
    doc.body.spellcheck = true
    doc.body.style.outline = 'none'
    doc.body.style.cursor = 'text'
    doc.body.addEventListener('input', () => setPreviewEdited(true))
  }

  const resetPreview = async () => {
    setPreviewEdited(false)
    if (!previewKind) return
    setLoading(true)
    try {
      const r = await api.post('/email/preview', {
        kind: previewKind,
        context: previewContext || {},
        to: form.to, cc: form.cc, subject: form.subject, message: form.message,
      })
      const d = r.data?.data || {}
      setHtml(d.html || '')
    } catch { /* keep current */ }
    finally { setLoading(false) }
  }

  const collectHtmlOverride = () => {
    if (!previewEdited || !iframeRef.current) return undefined
    try {
      const doc = iframeRef.current.contentDocument
      if (doc && doc.body) return doc.body.innerHTML
    } catch {}
    return undefined
  }

  const submitSend = async () => {
    if (!form.to.trim() || !form.subject.trim()) return
    setSending(true)
    try {
      const html_override = collectHtmlOverride()
      const payload = {
        to: form.to,
        cc: form.cc,
        subject: form.subject,
        message: form.message || undefined,
        ...(html_override ? { html_override } : {}),
      }
      if (customSend) {
        await customSend(payload)
      } else {
        await api.post('/email/send', {
          from_mailbox_id: fromMailboxId || undefined,
          kind: previewKind,
          context: previewContext || {},
          ...payload,
        })
      }
      onSent && onSent({ to: form.to, cc: form.cc, subject: form.subject })
    } catch (err) {
      // Surface failure but stay open so the user can retry / edit.
      // eslint-disable-next-line no-alert
      alert('Send failed: ' + (err.response?.data?.error || err.message))
    } finally {
      setSending(false)
    }
  }

  const submitSkip = async () => {
    if (!onSkipped) return
    setSkipping(true)
    try { await onSkipped() }
    finally { setSkipping(false) }
  }

  if (!open) return null
  const busy = sending || skipping || loading

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={busy ? undefined : onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: C.cardBg, borderRadius: 14, padding: 24, width: 760, maxWidth: '100%', maxHeight: '92vh', overflowY: 'auto', boxShadow: C.shadow }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 8 }}>
          <div>
            <h3 style={{ fontSize: 16, fontWeight: 800, margin: 0, color: C.text }}>{title}</h3>
            {subtitle && <p style={{ color: C.textMuted, fontSize: 12, margin: '4px 0 0' }}>{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            style={{ background: 'transparent', border: 'none', color: C.textMuted, cursor: busy ? 'default' : 'pointer', padding: 4, fontFamily: 'inherit' }}
            title="Close"
          >
            <X style={{ width: 16, height: 16 }} />
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 10, marginBottom: 14, marginTop: 14 }}>
          {fromOptions && (fromOptions.shared || fromOptions.mine) && (
            <div style={{ marginBottom: 12 }} data-from-selector>
              <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: C.textFaint, marginBottom: 4 }}>From</div>
              <select value={fromMailboxId} onChange={(e) => setFromMailboxId(e.target.value)} className="select-base w-full" style={{ fontSize: 13 }}>
                {fromOptions.shared && <option value="">{fromOptions.shared.address} · the label{fromOptions.shared.status !== 'active' ? ' (needs reconnecting)' : ''}</option>}
                {fromOptions.mine && <option value={fromOptions.mine.id}>{fromOptions.mine.address} · me</option>}
              </select>
              {!fromOptions.shared && <div style={{ fontSize: 11, color: '#b45309', marginTop: 4 }}>No shared mailbox owns this kind of mail; it will go from your own address.</div>}
            </div>
          )}
          <div>
            <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: C.textFaint, marginBottom: 4 }}>To</div>
            <input
              value={form.to}
              onChange={e => setForm(f => ({ ...f, to: e.target.value }))}
              disabled={busy}
              style={{ ...inputSty, width: '100%' }}
            />
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: C.textFaint, marginBottom: 4 }}>CC</div>
            <CcChipInput
              value={parseCcList(form.cc)}
              onChange={arr => setForm(f => ({ ...f, cc: joinCcList(arr) }))}
              disabled={busy}
              team={team}
              excludeEmail={form.to}
              placeholder="Type a name or email, press Enter"
              inputSty={inputSty}
              C={C}
            />
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: C.textFaint, marginBottom: 4 }}>Subject</div>
            <input
              value={form.subject}
              onChange={e => setForm(f => ({ ...f, subject: e.target.value }))}
              disabled={busy}
              style={{ ...inputSty, width: '100%' }}
            />
          </div>
          {showMessageField && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: C.textFaint, marginBottom: 4 }}>
                Personal Note <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0, color: C.textFaint }}>(optional)</span>
              </div>
              <textarea
                value={form.message}
                onChange={e => setForm(f => ({ ...f, message: e.target.value }))}
                disabled={busy}
                rows={3}
                style={{ ...inputSty, width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
              />
            </div>
          )}
        </div>

        {Array.isArray(attachmentLabels) && attachmentLabels.length > 0 && (
          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 8 }}>
            <span style={{ fontWeight: 700 }}>Attachments:</span> {attachmentLabels.join(', ')}
          </div>
        )}

        <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: C.textFaint, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>Email Preview</span>
          <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0, color: C.textFaint }}>— click any text to edit</span>
          {loading && <Loader style={{ width: 11, height: 11, animation: 'spin 0.8s linear infinite' }} />}
          {previewEdited && (
            <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 700, color: '#d97706' }}>Edited</span>
              {previewKind && (
                <button
                  type="button"
                  onClick={resetPreview}
                  disabled={busy}
                  style={{
                    background: 'transparent', color: C.text, border: '1px solid ' + C.border,
                    borderRadius: 6, padding: '3px 10px', fontSize: 11, fontWeight: 700,
                    textTransform: 'none', letterSpacing: 0, fontFamily: 'inherit',
                    cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1,
                  }}
                >
                  Reset preview
                </button>
              )}
            </span>
          )}
        </div>
        <div style={{ border: '1px solid ' + C.border, borderRadius: 10, overflow: 'hidden', marginBottom: 16, background: '#fff' }}>
          <iframe
            ref={iframeRef}
            onLoad={handleIframeLoad}
            title="Email preview"
            srcDoc={html}
            sandbox="allow-same-origin"
            style={{ width: '100%', height: 460, border: 'none', background: '#f9f9f9', display: 'block' }}
          />
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            style={{ background: C.elevBg, color: C.text, border: 'none', borderRadius: 8, padding: '10px 20px', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1 }}
          >
            Cancel
          </button>
          {onSkipped && (
            <button
              type="button"
              onClick={submitSkip}
              disabled={busy}
              style={{ background: 'transparent', color: C.textMuted, border: '1px solid ' + C.border, borderRadius: 8, padding: '10px 20px', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1 }}
            >
              {skipping ? 'Skipping…' : skipLabel}
            </button>
          )}
          <button
            type="button"
            onClick={submitSend}
            disabled={busy || !form.to.trim() || !form.subject.trim()}
            style={{
              background: '#16a34a', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 20px',
              fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
              cursor: (busy || !form.to.trim() || !form.subject.trim()) ? 'default' : 'pointer',
              opacity: (busy || !form.to.trim() || !form.subject.trim()) ? 0.5 : 1,
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            {sending ? <Loader style={{ width: 13, height: 13, animation: 'spin 0.8s linear infinite' }} /> : <Send style={{ width: 13, height: 13 }} />}
            {sending ? 'Sending…' : sendLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
