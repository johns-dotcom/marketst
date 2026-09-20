import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { X, Copy, BookmarkPlus, Upload, ExternalLink, Loader, History, Landmark, FileText, Layers } from 'lucide-react'
import api from '../../api'
import { DOC_TYPES, fileUrl } from '../../utils/entryFiles'

// The row drawer (2026-09-20): everything about one ledger row in a side
// panel, so the table can show nine columns instead of seventeen. Fields,
// documents (drop a file to attach one), the split family, bank evidence,
// QuickBooks, the change history, and the row utilities — Clone and Save as
// template. Opened from the row's › button or Enter on the focused row.

const fmtMoney = (n, cur = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD' }).format(Number(n) || 0)
const day = (d) => (d ? String(d).slice(0, 10) : '—')
const TEMPLATE_FIELDS = ['payee', 'description', 'category', 'artist', 'song', 'amount', 'currency', 'payment_method', 'boom_rep', 'notes', 'cobrand', 'is_reimbursement', 'vendor_email', 'vendor_name', 'vendor_bank', 'vendor_address', 'payment_terms', 'recoupable']
export const templateFieldsOf = (e) => Object.fromEntries(TEMPLATE_FIELDS.filter((k) => e[k] !== undefined && e[k] !== null && e[k] !== '').map((k) => [k, e[k]]))
// What a clone or a template posts: the same row, dated today, unpaid, no invoice number.
export const cloneBody = (fields) => ({ ...fields, invoice_date: new Date().toISOString().slice(0, 10), invoice_number: '', payment_status: 'Unpaid', payment_date: null, payment_ref: null })

function Row({ k, v, mono }) {
  if (v === undefined || v === null || v === '') return null
  return (
    <div style={{ display: 'flex', gap: 10, fontSize: 12.5, padding: '3px 0' }}>
      <span style={{ width: 120, flexShrink: 0, color: 'var(--color-text-muted, #6b7280)' }}>{k}</span>
      <span style={{ color: 'var(--color-text, #111)', fontFamily: mono ? 'ui-monospace, monospace' : 'inherit', minWidth: 0, wordBreak: 'break-word' }}>{String(v)}</span>
    </div>
  )
}
function Section({ title, icon: Icon, children, testId }) {
  return (
    <section style={{ marginTop: 16 }} data-drawer-section={testId}>
      <h4 style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--color-text-faint, #9ca3af)', margin: '0 0 6px', display: 'flex', alignItems: 'center', gap: 6 }}>{Icon && <Icon style={{ width: 12, height: 12 }} />}{title}</h4>
      {children}
    </section>
  )
}

export default function LedgerDrawer({ entry, family = [], onClose, onRefresh, canEdit, pendingFile, onPendingFileUsed, showToast }) {
  const [history, setHistory] = useState(null)
  const [busy, setBusy] = useState(null)
  const [dropFile, setDropFile] = useState(pendingFile || null)
  const [dragOver, setDragOver] = useState(false)
  const fileInput = useRef(null)
  useEffect(() => { setDropFile(pendingFile || null) }, [pendingFile, entry?.id])
  useEffect(() => {
    if (!entry) return
    setHistory(null)
    api.get(`/bk/entries/${entry.id}/history`).then((r) => setHistory(r.data?.data || [])).catch((e) => setHistory({ error: e.response?.status === 403 ? 'History is shown to bookkeeping roles.' : (e.response?.data?.error || e.message) }))
  }, [entry?.id])
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '')) onClose() }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  if (!entry) return null

  const upload = async (type) => {
    if (!dropFile) return
    setBusy(`upload:${type}`)
    try {
      const fd = new FormData(); fd.append('file', dropFile)
      await api.post(`/bk/entries/${entry.id}/file/${type}`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      setDropFile(null); onPendingFileUsed?.()
      showToast?.(`${type === 'w9' ? 'W-9' : type.charAt(0).toUpperCase() + type.slice(1)} attached`)
      await onRefresh?.()
    } catch (e) { showToast?.('Upload failed: ' + (e.response?.data?.error || e.message), true) }
    finally { setBusy(null) }
  }
  const clone = async () => {
    setBusy('clone')
    try {
      const r = await api.post('/bk/entries', cloneBody(templateFieldsOf(entry)))
      showToast?.(`Cloned ${entry.payee} — dated today, unpaid, no invoice number yet`)
      await onRefresh?.(r.data?.data?.id)
    } catch (e) { showToast?.('Clone failed: ' + (e.response?.data?.error || e.message), true) }
    finally { setBusy(null) }
  }
  const saveTemplate = async () => {
    const name = window.prompt('Name this template (rent, software, retainer…)', entry.payee || '')
    if (!name?.trim()) return
    setBusy('template')
    try { await api.post('/bk/templates', { name: name.trim(), fields: templateFieldsOf(entry) }); showToast?.(`Template “${name.trim()}” saved — find it under New from template`) }
    catch (e) { showToast?.('Could not save: ' + (e.response?.data?.error || e.message), true) }
    finally { setBusy(null) }
  }

  const docs = DOC_TYPES.filter((d) => entry[d.has] || entry[d.name])
  const ev = entry.bank_evidence
  const familyTotal = [entry, ...family].reduce((s, r) => s + (Number(r.amount) || 0), 0)
  const btn = { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 700, padding: '5px 10px', borderRadius: 8, border: '1px solid var(--color-border, #e5e7eb)', background: 'var(--color-bg-card, #fff)', color: 'var(--color-text, #111)', cursor: 'pointer', fontFamily: 'inherit' }

  return (
    <aside role="dialog" aria-label={`Ledger row ${entry.id}`} data-ledger-drawer data-entry-id={entry.id}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }} onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer?.files?.[0]; if (f) setDropFile(f) }}
      style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 440, maxWidth: '100vw', zIndex: 230, background: 'var(--color-bg-card, #fff)', borderLeft: '1px solid var(--color-border, #e5e7eb)', boxShadow: '-12px 0 40px rgba(0,0,0,.14)', overflowY: 'auto', padding: 18, outline: dragOver ? '2px dashed #d97706' : 'none', outlineOffset: -6 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <p style={{ margin: 0, fontSize: 10, fontWeight: 800, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--color-text-faint, #9ca3af)' }}>Ledger row · #{entry.id}{entry.parent_id ? ` · slice of #${entry.parent_id}` : family.length ? ` · split ${family.length + 1} ways` : ''}</p>
          <h3 style={{ margin: '2px 0 0', fontSize: 16, fontWeight: 900, color: 'var(--color-text, #111)', wordBreak: 'break-word' }}>{entry.payee || '—'}</h3>
          <p style={{ margin: '2px 0 0', fontSize: 14, fontWeight: 800, color: 'var(--color-text, #111)', fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(entry.amount, entry.currency)}{family.length > 0 && <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--color-text-muted, #6b7280)', marginLeft: 6 }}>family {fmtMoney(familyTotal, entry.currency)}</span>}</p>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: entry.payment_status === 'Paid' ? 'rgba(16,185,129,.12)' : 'rgba(245,158,11,.14)', color: entry.payment_status === 'Paid' ? '#047857' : '#b45309' }} data-drawer-status>{entry.payment_status || 'Unpaid'}</span>
            {entry.flagged && <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: 'rgba(245,158,11,.14)', color: '#b45309' }}>Flagged{entry.flag_reason ? `: ${entry.flag_reason}` : ''}</span>}
            {entry.on_hold && <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: 'rgba(107,114,128,.14)' }}>On hold</span>}
            {entry.rush_requested && <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: 'rgba(225,29,72,.12)', color: '#be123c' }}>Rush</span>}
            {entry.entry_source && <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: 'rgba(99,102,241,.12)', color: '#4338ca' }}>{entry.entry_source.replace(/_/g, ' ')}</span>}
          </div>
        </div>
        <button onClick={onClose} aria-label="Close" data-drawer-close style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted, #6b7280)', padding: 4 }}><X style={{ width: 16, height: 16 }} /></button>
      </div>

      {canEdit && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 }} data-drawer-utilities>
          <button onClick={clone} disabled={!!busy} style={btn} data-drawer-clone title="A new row with the same payee, category, artist, amount and details — dated today, unpaid, no invoice number">{busy === 'clone' ? <Loader style={{ width: 12, height: 12 }} className="animate-spin" /> : <Copy style={{ width: 12, height: 12 }} />} Clone</button>
          <button onClick={saveTemplate} disabled={!!busy} style={btn} data-drawer-template title="Save these fields under a name; New from template posts them as a fresh row">{busy === 'template' ? <Loader style={{ width: 12, height: 12 }} className="animate-spin" /> : <BookmarkPlus style={{ width: 12, height: 12 }} />} Save as template</button>
          <button onClick={() => fileInput.current?.click()} disabled={!!busy} style={btn} data-drawer-attach title="Attach a file — or drag one onto this panel or onto the row"><Upload style={{ width: 12, height: 12 }} /> Attach…</button>
          <input ref={fileInput} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) setDropFile(f); e.target.value = '' }} />
          <Link to={`/bk/ledger?focus=${entry.id}`} style={{ ...btn, textDecoration: 'none' }} title="Highlight this row in the table"><ExternalLink style={{ width: 12, height: 12 }} /> Focus row</Link>
        </div>
      )}
      {dropFile && (
        <div data-drawer-dropfile style={{ marginTop: 10, padding: 10, borderRadius: 10, border: '1px dashed #d97706', background: 'rgba(245,158,11,.07)', fontSize: 12 }}>
          <p style={{ margin: '0 0 6px', fontWeight: 700 }}>Attach <span style={{ fontFamily: 'ui-monospace, monospace' }}>{dropFile.name}</span> as…</p>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[['invoice', 'Invoice'], ['w9', 'W-9'], ['proof', 'Proof of payment'], ['receipt', 'Receipt']].map(([t, l]) => (
              <button key={t} onClick={() => upload(t)} disabled={!!busy} style={btn} data-drawer-upload={t}>{busy === `upload:${t}` ? <Loader style={{ width: 12, height: 12 }} className="animate-spin" /> : null}{l}</button>
            ))}
            <button onClick={() => { setDropFile(null); onPendingFileUsed?.() }} style={{ ...btn, color: 'var(--color-text-muted, #6b7280)' }}>Cancel</button>
          </div>
        </div>
      )}

      <Section title="Details" icon={FileText} testId="details">
        <Row k="Invoice date" v={day(entry.invoice_date)} />
        <Row k="Invoice #" v={entry.invoice_number} mono />
        <Row k="Category" v={entry.category} />
        <Row k="Artist" v={entry.artist} />
        <Row k="Song" v={entry.song} />
        <Row k="Description" v={entry.description} />
        <Row k="Method" v={entry.payment_method} />
        <Row k="Terms" v={entry.payment_terms} />
        <Row k="Due" v={entry.scheduled_payment_date ? day(entry.scheduled_payment_date) : null} />
        <Row k="Paid on" v={entry.payment_date ? day(entry.payment_date) : null} />
        <Row k="Paid by" v={entry.paid_by} />
        <Row k="Payment ref" v={entry.payment_ref} mono />
        <Row k="Rep" v={entry.boom_rep} />
        <Row k="Vendor email" v={entry.vendor_email} />
        <Row k="Recoupable" v={entry.recoupable === true ? 'Yes' : entry.recoupable === false ? 'No' : null} />
        <Row k="Recoup label" v={entry.recoupment_label} />
        <Row k="Notes" v={entry.notes} />
        <Row k="Approved by" v={entry.approved_by} />
        <Row k="Added" v={entry.created_at ? day(entry.created_at) : null} />
      </Section>

      <Section title="Documents" icon={FileText} testId="documents">
        {docs.length ? docs.map((d) => (
          <a key={d.type} href={fileUrl(entry, d.type)} target="_blank" rel="noreferrer" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, padding: '4px 0', color: 'var(--color-text, #111)', textDecoration: 'none' }} data-drawer-doc={d.type}>
            <ExternalLink style={{ width: 12, height: 12, color: 'var(--color-text-muted, #6b7280)' }} /> <span style={{ fontWeight: 700 }}>{d.label}</span> <span style={{ color: 'var(--color-text-muted, #6b7280)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry[d.name] || ''}</span>
          </a>
        )) : <p style={{ margin: 0, fontSize: 12, color: 'var(--color-text-muted, #6b7280)' }}>Nothing attached. Drag a file here to add one.</p>}
        {entry.w9_entry_id && entry.w9_entry_id !== entry.id && <p style={{ margin: '4px 0 0', fontSize: 11.5, color: 'var(--color-text-muted, #6b7280)' }}>W-9 on file for this vendor, filed on row #{entry.w9_entry_id}.</p>}
      </Section>

      {(family.length > 0 || entry.parent_id) && (
        <Section title="Split family" icon={Layers} testId="family">
          {family.map((r) => (
            <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12.5, padding: '3px 0' }}>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>#{r.id} · {r.artist || '—'}{r.song ? ` · ${r.song}` : ''} · {r.category || '—'}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>{fmtMoney(r.amount, r.currency)}</span>
            </div>
          ))}
          {entry.parent_id && <p style={{ margin: 0, fontSize: 12, color: 'var(--color-text-muted, #6b7280)' }}>This row is one slice of invoice #{entry.parent_id}; the document and the vendor's details live on the parent.</p>}
        </Section>
      )}

      <Section title="Bank" icon={Landmark} testId="bank">
        {ev ? (
          <>
            <Row k="Matched to" v={`${String(ev.account || '').toUpperCase()} line${ev.txn_id ? ` #${ev.txn_id}` : ''}${ev.txn_date ? ` on ${day(ev.txn_date)}` : ''}`} />
            {ev.statement_id && <Row k="Statement" v={`#${ev.statement_id}`} />}
          </>
        ) : entry.payment_status === 'Paid'
          ? <p style={{ margin: 0, fontSize: 12, color: '#b45309' }}>Marked Paid, no bank line matched yet. It will show as verified once the statement covering {day(entry.payment_date)} is uploaded and matched.</p>
          : <p style={{ margin: 0, fontSize: 12, color: 'var(--color-text-muted, #6b7280)' }}>Unpaid — nothing to match yet.</p>}
        <Row k="QuickBooks" v={entry.in_quickbooks === 'Yes' ? 'Posted' : entry.in_quickbooks === 'No' ? 'Not posted' : null} />
      </Section>

      <Section title="History" icon={History} testId="history">
        {history === null && <p style={{ margin: 0, fontSize: 12, color: 'var(--color-text-muted, #6b7280)' }}>Loading…</p>}
        {history?.error && <p style={{ margin: 0, fontSize: 12, color: 'var(--color-text-muted, #6b7280)' }}>{history.error}</p>}
        {Array.isArray(history) && !history.length && <p style={{ margin: 0, fontSize: 12, color: 'var(--color-text-muted, #6b7280)' }}>No changes recorded for this row.</p>}
        {Array.isArray(history) && history.slice(0, 50).map((h) => (
          <div key={h.id} style={{ fontSize: 12, padding: '4px 0', borderBottom: '1px solid var(--color-border, #eee)' }} data-drawer-history-row>
            <span style={{ color: 'var(--color-text-muted, #6b7280)' }}>{h.ts ? new Date(h.ts).toISOString().slice(0, 16).replace('T', ' ') : ''}</span> · <strong>{h.user_name || 'system'}</strong> · {h.action}{h.field ? ` · ${h.field}` : ''}
            {(h.old_value || h.new_value) && <div style={{ color: 'var(--color-text-muted, #6b7280)' }}>{h.old_value ?? '—'} → {h.new_value ?? '—'}</div>}
            {h.details && <div style={{ color: 'var(--color-text-muted, #6b7280)' }}>{h.details}</div>}
          </div>
        ))}
      </Section>
    </aside>
  )
}

// New from template — a menu for the toolbar. Lists the label's templates and
// posts one as a fresh row (dated today, unpaid) through POST /bk/entries.
export function TemplatesMenu({ onCreated, showToast, buttonStyle, C }) {
  const [open, setOpen] = useState(false)
  const [list, setList] = useState(null)
  const [busy, setBusy] = useState(null)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    api.get('/bk/templates').then((r) => setList(r.data?.data || [])).catch(() => setList([]))
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDoc); return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  const use = async (t) => {
    setBusy(t.id)
    try {
      const r = await api.post('/bk/entries', cloneBody(t.fields || {}))
      api.post(`/bk/templates/${t.id}/used`).catch(() => {})
      setOpen(false); showToast?.(`Added ${t.fields?.payee || t.name} from the template — dated today, unpaid`)
      await onCreated?.(r.data?.data?.id)
    } catch (e) { showToast?.('Could not add: ' + (e.response?.data?.error || e.message), true) }
    finally { setBusy(null) }
  }
  const remove = async (t) => { if (!window.confirm(`Delete the template “${t.name}”?`)) return; await api.delete(`/bk/templates/${t.id}`).catch(() => {}); setList((l) => (l || []).filter((x) => x.id !== t.id)) }
  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button type="button" onClick={() => setOpen((v) => !v)} style={{ ...buttonStyle, display: 'inline-flex', alignItems: 'center', gap: 5 }} data-ledger-templates title="Add a row from a saved template (rent, software, retainers)">
        <BookmarkPlus style={{ width: 13, height: 13 }} /> From template
      </button>
      {open && (
        <div data-ledger-templates-menu style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 220, minWidth: 260, background: C.cardBg, border: `1.5px solid ${C.border}`, borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,.14)', padding: 6 }}>
          {list === null && <p style={{ margin: 0, padding: 8, fontSize: 12, color: C.textMuted }}>Loading…</p>}
          {Array.isArray(list) && !list.length && <p style={{ margin: 0, padding: 8, fontSize: 12, color: C.textMuted }}>No templates yet. Open a row and choose Save as template.</p>}
          {Array.isArray(list) && list.map((t) => (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px', borderRadius: 7 }} data-ledger-template={t.id}>
              <button type="button" onClick={() => use(t)} disabled={!!busy} style={{ flex: 1, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', color: C.text, fontSize: 12.5, padding: '3px 2px' }}>
                <span style={{ fontWeight: 700 }}>{t.name}</span>
                <span style={{ display: 'block', fontSize: 11, color: C.textMuted }}>{t.fields?.payee || ''}{t.fields?.amount ? ` · ${fmtMoney(t.fields.amount, t.fields.currency)}` : ''}{t.fields?.category ? ` · ${t.fields.category}` : ''}</span>
              </button>
              {busy === t.id ? <Loader style={{ width: 12, height: 12 }} className="animate-spin" /> : <button type="button" onClick={() => remove(t)} aria-label={`Delete ${t.name}`} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.textFaint, padding: 2 }}><X style={{ width: 11, height: 11 }} /></button>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
