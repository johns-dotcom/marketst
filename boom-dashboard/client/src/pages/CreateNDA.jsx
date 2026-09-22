import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { Trash2, Download, Plus, Loader, FileText, Eye, X, Pencil, AlertCircle } from 'lucide-react'
import { jsPDF } from 'jspdf'
import api from '../api'
import Skeleton from '../components/Skeleton'
import useLabel from '../hooks/useLabel'
import { SendForSignatureButton, useEnvelopes } from '../components/SendForSignature'
import {
  NDA_TEMPLATES, getTemplate, renderSignatureFor,
  BOOM_DEFAULTS, applyLabelDefaults, formatEffectiveDate, escapeRegex, getHeadingLevel,
  BASE_FIELDS, BASE_BODY_FIELDS,
} from './nda-templates'

// The base set of form fields every NDA has — merged with each
// template's `defaults` + `extraFields` to build the initial blank
// form for that template. Kept in sync with BASE_FIELDS in
// nda-templates/shared (that's the render order + validation source).
const BASE_BLANK = {
  effective_date: '',
  owner_name: BOOM_DEFAULTS.owner_name,
  owner_address: BOOM_DEFAULTS.owner_address,
  recipient_name: '',
  recipient_email: '',
  recipient_address: '',
  signatory_name: BOOM_DEFAULTS.signatory_name,
  signatory_title: BOOM_DEFAULTS.signatory_title,
  custom_body: '',
}

// Merge base form + template defaults + zero-values for any extra
// fields the template declares. Called every time the active template
// changes so the form always carries the right shape.
function blankFormFor(template) {
  const extras = {}
  for (const f of (template.extraFields || [])) extras[f.key] = f.default ?? ''
  return { ...BASE_BLANK, ...template.defaults, ...extras }
}

// formatEffectiveDate + getHeadingLevel are imported from ./nda-templates.


// On-screen preview — renders the editable body text inside a fixed-height
// scrollable container so the page stays manageable. Each paragraph is
// classified by getHeadingLevel: h1 (centered title), h2 (bold heading),
// or body. Signature blocks render statically at the bottom — they are
// not part of the body text the user edits.
function NDAPreview({ bodyText, data, template }) {
  const paragraphs = (bodyText || '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
  // Signature block delegated to the template so each variant can
  // control what appears (Owner vs Recipient signatory lines, optional
  // Title row, etc.). Falls back to the shared default when template
  // is omitted or doesn't declare renderSignature.
  const sig = renderSignatureFor(template, data || {})
  return (
    <div data-tour="nda-preview" className="bg-card border border-rule rounded-lg shadow-sm font-sans">
      <div className="px-10 py-8 max-h-[640px] overflow-y-auto space-y-4">
        {paragraphs.map((para, i) => {
          const level = getHeadingLevel(para)
          if (level === 2) {
            return (
              <h1 key={i} className="text-2xl font-black tracking-tight text-gray-900 text-center">
                {para}
              </h1>
            )
          }
          if (level === 1) {
            return (
              <p key={i} className="text-[13px] font-bold text-gray-900">
                {para}
              </p>
            )
          }
          // Body — preserve any single newlines inside the paragraph (the
          // bullet block uses them to keep dashes one per line).
          return (
            <p key={i} className="text-[13px] text-gray-700 leading-relaxed whitespace-pre-line">
              {para}
            </p>
          )
        })}
        <div className="text-[13px] text-gray-700 space-y-1.5 pt-4">
          <p><strong>{sig.owner.party}</strong></p>
          {sig.owner.lines.map((l, i) => <p key={`o${i}`}>{l}</p>)}
          <p className="pt-3"><strong>{sig.recipient.party}</strong></p>
          {sig.recipient.lines.map((l, i) => <p key={`r${i}`}>{l}</p>)}
        </div>
      </div>
    </div>
  )
}

// Helper used in a couple of places to seed the form with a blank
// payload + a freshly-rendered body string for the given template.
function freshBlankForm(template) {
  const base = blankFormFor(template)
  base.custom_body = template.buildBody(base)
  return base
}

export default function CreateNDA() {
  // Which template is active — driven by the /:template URL segment
  // (falls back to the first template in the registry when missing or
  // unknown). Switching templates is a navigation, not a form edit —
  // the URL is the source of truth so refresh + deep-link Just Work.
  const params = useParams()
  const navigate = useNavigate()
  const activeTemplate = getTemplate(params.template)

  const [ndas, setNdas] = useState([])
  const [envelopes, reloadEnvelopes] = useEnvelopes('nda')   // DocuSign: latest envelope per NDA
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState(() => freshBlankForm(activeTemplate))
  // Owner and signatory come from Settings › Label. When it loads, fill the
  // fields the person has not typed into yet.
  const label = useLabel()
  useEffect(() => {
    if (!label) return
    const before = { ...BOOM_DEFAULTS }
    const d = applyLabelDefaults(label)
    setForm((f) => ({
      ...f,
      owner_name: (!f.owner_name || f.owner_name === before.owner_name) ? d.owner_name : f.owner_name,
      owner_address: (!f.owner_address || f.owner_address === before.owner_address) ? d.owner_address : f.owner_address,
      signatory_name: (!f.signatory_name || f.signatory_name === before.signatory_name) ? d.signatory_name : f.signatory_name,
      signatory_title: (!f.signatory_title || f.signatory_title === before.signatory_title) ? d.signatory_title : f.signatory_title,
    }))
  }, [label]) // eslint-disable-line react-hooks/exhaustive-deps
  const [editing, setEditing] = useState(null)
  const [previewItem, setPreviewItem] = useState(null)
  // bodyDirty controls how form-field changes flow into the body:
  //   false → full rebuild from the template (used while the user hasn't
  //           touched the body yet).
  //   true  → literal find/replace of just the changed field's old value with
  //           the new one, so user edits in the textarea survive while
  //           something like an owner-name change still propagates everywhere
  //           the owner appears in the document.
  // The "Reset to template" button clears the flag.
  const [bodyDirty, setBodyDirty] = useState(false)
  // Tracks the form snapshot that matches what's currently substituted into
  // custom_body, so the dirty-mode diff knows what string to find when
  // replacing. Kept in sync with: full rebuilds, dirty-mode replacements, and
  // startEdit (when the loaded body is presumed to reflect the loaded form).
  const prevFormRef = useRef(form)
  // Debounce handle for the dirty-mode body sync. Without debouncing, a user
  // typing the owner name letter-by-letter would trigger a replacement on
  // every keystroke — after typing "L" then "Lu", every single "L" in the
  // body (Legal, Limited, LLC, …) would extend to "Lu", cascading into
  // gibberish. With debouncing, the diff fires once typing settles.
  const syncTimerRef = useRef(null)

  // When the URL's :template segment changes (direct-URL navigation
  // or Back/Forward), reset the form to the new template's shape. The
  // eager path (tab click) already resets via switchTemplate — this
  // catches the cases that don't go through it. Guarded by `editing`
  // so an in-progress edit isn't clobbered.
  const lastTemplateRef = useRef(activeTemplate.id)
  useEffect(() => {
    if (lastTemplateRef.current === activeTemplate.id) return
    lastTemplateRef.current = activeTemplate.id
    if (editing) return
    setForm(freshBlankForm(activeTemplate))
    setBodyDirty(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTemplate.id])

  const fetchNdas = async () => {
    try {
      const res = await api.get('/ndas')
      setNdas(res.data.data || [])
    } catch (err) {
      console.error('NDA list fetch failed:', err)
    }
  }
  useEffect(() => { fetchNdas().then(() => setLoading(false)) }, [])

  // Computes the body + advanced prev snapshot for the dirty-mode diff. Pure-
  // ish (mutates nothing) so handleCreate can also call it to flush a pending
  // sync at submit time. Returns null when there's nothing to change.
  //
  // Substitution uses a word-boundary regex, NOT a raw substring split. If the
  // user pauses mid-typing a short field value (e.g., signatory name "T"
  // before continuing to "Tyler Henry"), the next debounce sees prev="T" /
  // new="Tyler Henry" — a raw replace turns every literal "T" in the body
  // ("WHISTLEBLOWER", "PROTECTION", "This", "Trade", …) into "Tyler Henry".
  // \b ensures the match is bounded by non-word chars on both sides, so a
  // single-letter prev only matches a standalone "T" (the one in the
  // signature line), never letters inside other words.
  const computeBodyDiff = (formSnapshot, prev) => {
    // Watch the base body fields + any template-specific extras. If a
    // template says "project_name appears in the body", it goes here so
    // renaming it fires the same find-replace pass.
    const fields = [...(activeTemplate.bodyFields || BASE_BODY_FIELDS)]
    const replacements = []
    for (const k of fields) {
      const oldV = prev[k]; const newV = formSnapshot[k]
      if (oldV && newV && oldV !== newV) replacements.push([oldV, newV, k])
    }
    const oldDate = formatEffectiveDate(prev.effective_date)
    const newDate = formatEffectiveDate(formSnapshot.effective_date)
    if (oldDate && newDate && oldDate !== newDate) replacements.push([oldDate, newDate, 'effective_date'])
    if (!replacements.length) return null
    let body = formSnapshot.custom_body || ''
    for (const [from, to] of replacements) {
      const re = new RegExp(`\\b${escapeRegex(from)}\\b`, 'g')
      body = body.replace(re, to)
    }
    const nextPrev = { ...prev }
    for (const [, , k] of replacements) {
      nextPrev[k] = k === 'effective_date' ? formSnapshot.effective_date : formSnapshot[k]
    }
    return { body, nextPrev }
  }

  // Signature of the fields the auto-sync watches — base body fields
  // + effective date + this template's optional-clause keys + any
  // extra body fields declared by the template. Concatenated to a
  // string so useEffect's static dep array can watch "any of these".
  const watchedKeys = [
    ...BASE_BODY_FIELDS, 'effective_date',
    ...(activeTemplate.optionalClauses || []).map(c => c.key),
    ...(activeTemplate.bodyFields || []).filter(k => !BASE_BODY_FIELDS.includes(k)),
  ]
  const watchedSig = watchedKeys.map(k => `${k}=${form[k]}`).join('|')

  // Auto-sync the body with form values. See the bodyDirty comment above for
  // the two modes.
  useEffect(() => {
    if (!bodyDirty) {
      setForm(f => ({ ...f, custom_body: activeTemplate.buildBody(f) }))
      prevFormRef.current = form
      return
    }
    // Debounce — see syncTimerRef comment for why we can't run this on every
    // keystroke. Flush is also handled in handleCreate before submit, so a
    // save that lands before the timer fires still gets the up-to-date body.
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current)
    syncTimerRef.current = setTimeout(() => {
      syncTimerRef.current = null
      const diff = computeBodyDiff(form, prevFormRef.current)
      if (!diff) return
      setForm(f => ({ ...f, custom_body: diff.body }))
      prevFormRef.current = diff.nextPrev
    }, 400)
    return () => { if (syncTimerRef.current) { clearTimeout(syncTimerRef.current); syncTimerRef.current = null } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedSig, bodyDirty, activeTemplate.id])

  const setField = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const handleBodyChange = (val) => {
    setForm(f => ({ ...f, custom_body: val }))
    if (!bodyDirty) setBodyDirty(true)
  }
  const handleBodyReset = () => {
    setForm(f => ({ ...f, custom_body: activeTemplate.buildBody(f) }))
    setBodyDirty(false)
  }

  // Sections the current template considers mandatory. Reads from the
  // template's own `mandatorySections` list so each template can
  // declare its own required markers. If a loaded body is missing any
  // of these, it was saved against an older template version (or a
  // manual edit deleted them) and the PDF will be incomplete.
  const missingMandatory = (() => {
    if (!editing || !form.custom_body) return []
    return (activeTemplate.mandatorySections || [])
      .filter(s => !s.test.test(form.custom_body))
      .map(s => s.name)
  })()

  // Section toggles work cleanly when the body is untouched — the useEffect
  // above rebuilds the body from the template automatically. With a dirty
  // body we'd be choosing between (a) silently keeping the user's edits and
  // letting the toggle do nothing, or (b) clobbering edits with a fresh
  // template. (b) at least makes the toggle observable; warn before doing it.
  const toggleSection = (key, value) => {
    if (bodyDirty) {
      const ok = window.confirm('Toggling this section will replace your custom body with a fresh template that reflects all current fields. Continue?')
      if (!ok) return
      setForm(f => ({ ...f, [key]: value }))
      setBodyDirty(false)
      return
    }
    setForm(f => ({ ...f, [key]: value }))
  }

  const startEdit = (nda) => {
    setEditing(nda)
    // Switch to the NDA's saved template BEFORE loading its data so
    // clause toggles + extra fields render against the right shape.
    // If the URL already reflects the NDA's template, this is a no-op.
    const ndaTemplate = getTemplate(nda.template_id)
    if (ndaTemplate.id !== activeTemplate.id) {
      navigate(`/create-nda/${ndaTemplate.id}`)
    }
    // Derive the optional-clause toggles from the SAVED BODY rather than the
    // DB column. The body is what becomes the PDF, so it's the only honest
    // signal of what the NDA actually contains. A NULL DB column would lie
    // about pre-toggle-feature NDAs, and a manual delete-of-the-section
    // from the textarea would lie about post-feature ones. Reading the body
    // keeps the checkboxes in sync with reality in both cases.
    const savedBody = nda.custom_body || ''
    const hasSavedBody = !!nda.custom_body
    // Base fields — same across every template.
    const next = {
      effective_date: (nda.effective_date || '').slice(0, 10),
      owner_name: nda.owner_name || BOOM_DEFAULTS.owner_name,
      owner_address: nda.owner_address || '',
      recipient_name: nda.recipient_name || '',
      recipient_email: nda.recipient_email || '',
      recipient_address: nda.recipient_address || '',
      signatory_name: nda.signatory_name || BOOM_DEFAULTS.signatory_name,
      signatory_title: nda.signatory_title || BOOM_DEFAULTS.signatory_title,
      custom_body: savedBody,
    }
    // Optional-clause toggles — pulled from the saved body via each
    // clause's `marker` regex. Falls back to the DB column when no
    // body is saved (very old rows) and finally to the template
    // default when the column is null. `nda[c.key]` is checked with
    // `!== false` so NULL / undefined still counts as "included",
    // matching the historical behavior.
    for (const c of (ndaTemplate.optionalClauses || [])) {
      if (hasSavedBody) {
        next[c.key] = c.marker ? c.marker.test(savedBody) : (nda[c.key] !== false)
      } else {
        next[c.key] = nda[c.key] !== false
      }
    }
    // Extra fields from template_data JSONB. Standard has none; the
    // hydration below is a no-op for it.
    const td = nda.template_data || {}
    for (const f of (ndaTemplate.extraFields || [])) {
      next[f.key] = td[f.key] ?? (f.default ?? '')
    }
    // A saved NDA without a custom_body is older / generated before this
    // feature existed — render the default template from its fields so the
    // editor isn't blank.
    if (!next.custom_body) next.custom_body = ndaTemplate.buildBody(next)
    setForm(next)
    // Treat a saved body as dirty so the auto-sync doesn't clobber the
    // user's prior edits on the next form-field change.
    setBodyDirty(!!nda.custom_body)
    // Seed the dirty-mode diff with the loaded values — the loaded body is
    // assumed to already reflect them, so a later edit to e.g. owner_name
    // knows to find the old loaded name in the body and replace it.
    prevFormRef.current = next
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const cancelEdit = () => { setEditing(null); setForm(freshBlankForm(activeTemplate)); setBodyDirty(false) }

  const [saveError, setSaveError] = useState('')
  const handleCreate = async (e) => {
    e.preventDefault()
    setSaveError('')
    if (!form.effective_date || !form.owner_name || !form.recipient_name) {
      setSaveError('Effective date, owner name, and recipient name are required.')
      return
    }
    // Flush any pending dirty-mode body sync. The auto-sync debounces typing,
    // so if the user clicks Save before the timer fires, the body still has
    // the pre-edit values. Compute the diff inline so the payload is fresh.
    let payload = form
    if (bodyDirty) {
      if (syncTimerRef.current) { clearTimeout(syncTimerRef.current); syncTimerRef.current = null }
      const diff = computeBodyDiff(form, prevFormRef.current)
      if (diff) {
        payload = { ...form, custom_body: diff.body }
        setForm(f => ({ ...f, custom_body: diff.body }))
        prevFormRef.current = diff.nextPrev
      }
    }
    // Serialize template-specific extra fields into template_data so
    // the server persists them in one JSONB column (no per-template
    // schema churn). Standard has no extras → template_data stays null.
    const templateData = {}
    for (const f of (activeTemplate.extraFields || [])) {
      const v = form[f.key]
      if (v !== '' && v !== null && v !== undefined) templateData[f.key] = v
    }
    payload = {
      ...payload,
      template_id: activeTemplate.id,
      template_data: Object.keys(templateData).length ? templateData : null,
    }
    setCreating(true)
    try {
      if (editing) {
        await api.put(`/ndas/${editing.id}`, payload)
        setEditing(null)
      } else {
        const created = await api.post('/ndas', payload)
        setAttachedNote('')
        attachToArtist({ ...payload, ...(created?.data?.data || {}) })
      }
      setForm(freshBlankForm(activeTemplate))
      setBodyDirty(false)
      await fetchNdas()
    } catch (err) {
      const msg = err?.response?.data?.error || err?.message || 'Save failed'
      setSaveError(msg)
      console.error('NDA save failed:', err)
    }
    setCreating(false)
  }

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this NDA record? This does not revoke any already-issued copies.')) return
    try {
      await api.delete(`/ndas/${id}`)
      await fetchNdas()
    } catch { /* ignore */ }
  }

  // Render the NDA to a multi-page PDF via jsPDF. Mirrors CreateInvoice's
  // handleDownload — selectable / searchable text, helvetica, automatic
  // page break when y exceeds the bottom margin.
  // buildNdaPdf returns the document and its filename; handleDownload saves
  // it, and the roster attach below uploads it — one rendering, two exits.
  const buildNdaPdf = (nda) => {
    const doc = new jsPDF({ unit: 'pt', format: 'letter' })
    const W = doc.internal.pageSize.getWidth()
    const H = doc.internal.pageSize.getHeight()
    const MX = 72   // 1 inch side margins
    const MY = 72
    const lineH = 14
    const bodyW = W - MX * 2

    let y = MY

    const ensureSpace = (need = lineH) => {
      if (y + need > H - MY) {
        doc.addPage()
        y = MY
      }
    }

    // Render from the saved custom body if present; fall back to the
    // template for legacy NDAs that pre-date the editable-body feature.
    // Legacy fallback — for an old row without custom_body we
    // reconstruct the body from THAT NDA's template, not the currently
    // active one on screen (which may be unrelated).
    const ndaTemplate = getTemplate(nda.template_id)
    // Merge template_data JSONB extras (per-template fields) onto the
    // row so buildBody + renderSignature both see them. Standard NDAs
    // have no extras → merged is functionally the same as nda.
    const merged = { ...nda, ...(nda.template_data || {}) }
    const bodyText = nda.custom_body || ndaTemplate.buildBody(merged)
    const paragraphs = bodyText.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
    paragraphs.forEach(para => {
      const level = getHeadingLevel(para)
      if (level === 2) {
        // h1 — centered, larger.
        ensureSpace(40)
        doc.setFont('helvetica', 'bold')
        doc.setFontSize(16)
        doc.setTextColor(17, 17, 17)
        const w = doc.getTextWidth(para)
        doc.text(para, (W - w) / 2, y + 20)
        y += 44
      } else if (level === 1) {
        // h2 — bold section header.
        ensureSpace(lineH + 8)
        y += 6
        doc.setFont('helvetica', 'bold')
        doc.setFontSize(11)
        doc.setTextColor(17, 17, 17)
        const lines = doc.splitTextToSize(para, bodyW)
        lines.forEach(line => {
          ensureSpace(lineH)
          doc.text(line, MX, y)
          y += lineH
        })
        y += 4
      } else {
        // Body — keep single newlines so bullet blocks render one item
        // per line; wrap each line to the page width independently.
        doc.setFont('helvetica', 'normal')
        doc.setFontSize(11)
        doc.setTextColor(51, 51, 51)
        const lines = para.split('\n').flatMap(l => doc.splitTextToSize(l, bodyW))
        lines.forEach(line => {
          ensureSpace(lineH)
          doc.text(line, MX, y)
          y += lineH
        })
        y += 6
      }
    })

    // Signature blocks — delegated to the template's renderSignature
    // so each variant can control the shape (extra Title lines for
    // corporate recipients, etc.). Keep the two blocks on the same
    // page — force a new page first if there isn't enough room.
    if (y + 240 > H - MY) { doc.addPage(); y = MY }
    const sig = renderSignatureFor(ndaTemplate, merged)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(11)
    doc.setTextColor(17, 17, 17)
    doc.text(sig.owner.party, MX, y); y += lineH + 6
    doc.setFont('helvetica', 'normal')
    for (const line of sig.owner.lines) {
      doc.text(line, MX, y); y += lineH + 4
    }
    y += 14 // extra gap between the two blocks
    doc.setFont('helvetica', 'bold')
    doc.text(sig.recipient.party, MX, y); y += lineH + 6
    doc.setFont('helvetica', 'normal')
    for (const line of sig.recipient.lines) {
      doc.text(line, MX, y); y += lineH + 4
    }

    const safeRecip = (nda.recipient_name || 'NDA').replace(/[^a-zA-Z0-9]/g, '_')
    const dateTag = (nda.effective_date || new Date().toISOString().slice(0, 10)).slice(0, 10)
    // Filename prefix comes from the NDA's own template (not
    // activeTemplate) so a Standard NDA downloaded while the user is
    // browsing a different tab still reads as MarketStreet-NDA-…
    const prefix = ndaTemplate.filenamePrefix || 'NDA'
    return { doc, filename: `MarketStreet-${prefix}-${safeRecip}-${dateTag}.pdf` }
  }
  const handleDownload = (nda) => { const { doc, filename } = buildNdaPdf(nda); doc.save(filename) }

  // A generated NDA belongs on the artist it names. When the recipient is a
  // roster artist (GET /artists/resolve folds spelling), the PDF is uploaded to
  // that artist's Documents — best-effort: the NDA record is already saved, so
  // a failed attach is a sentence, not a failed save.
  const [attachedNote, setAttachedNote] = useState('')
  const attachToArtist = async (nda) => {
    const name = String(nda.recipient_name || '').trim()
    if (!name) return
    try {
      const r = await api.get('/artists/resolve', { params: { name } })
      const artist = r.data?.data
      if (!artist?.id) return
      const { doc, filename } = buildNdaPdf(nda)
      const fd = new FormData()
      fd.append('file', doc.output('blob'), filename)
      fd.append('label', 'Generated NDA')
      await api.post(`/artists/${artist.id}/files`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      setAttachedNote({ text: `Saved a copy to ${artist.name}'s Documents.`, to: `/artists/${artist.id}?tab=documents` })
    } catch (err) {
      console.warn('NDA attach to artist skipped:', err?.message || err)
    }
  }

  // Render the NDA to a real .docx via the `docx` package (dynamically
  // imported so it stays out of the main bundle). Mirrors handleDownload's
  // structure: same body derivation, heading levels, and signature blocks —
  // 1-inch margins, 16pt centered title, 11pt body (docx sizes are
  // half-points). Word swaps Helvetica for Arial automatically.
  const handleDownloadWord = async (nda) => {
    const { Document, Packer, Paragraph, TextRun, AlignmentType } = await import('docx')

    const ndaTemplate = getTemplate(nda.template_id)
    const merged = { ...nda, ...(nda.template_data || {}) }
    const bodyText = nda.custom_body || ndaTemplate.buildBody(merged)
    const paragraphs = bodyText.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)

    const children = []
    paragraphs.forEach(para => {
      const level = getHeadingLevel(para)
      if (level === 2) {
        children.push(new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 320 },
          children: [new TextRun({ text: para, bold: true, size: 32 })],
        }))
      } else if (level === 1) {
        children.push(new Paragraph({
          spacing: { before: 160, after: 100 },
          children: [new TextRun({ text: para, bold: true, size: 22 })],
        }))
      } else {
        // Preserve single newlines (bullet blocks) as line breaks inside
        // one paragraph, matching the PDF's one-item-per-line rendering.
        const lines = para.split('\n')
        children.push(new Paragraph({
          spacing: { after: 140 },
          children: lines.map((l, i) => new TextRun({ text: l, size: 22, break: i === 0 ? 0 : 1 })),
        }))
      }
    })

    const sig = renderSignatureFor(ndaTemplate, merged)
    children.push(new Paragraph({
      spacing: { before: 480, after: 120 },
      children: [new TextRun({ text: sig.owner.party, bold: true, size: 22 })],
    }))
    sig.owner.lines.forEach(line => children.push(new Paragraph({
      spacing: { after: 100 },
      children: [new TextRun({ text: line, size: 22 })],
    })))
    children.push(new Paragraph({
      spacing: { before: 320, after: 120 },
      children: [new TextRun({ text: sig.recipient.party, bold: true, size: 22 })],
    }))
    sig.recipient.lines.forEach(line => children.push(new Paragraph({
      spacing: { after: 100 },
      children: [new TextRun({ text: line, size: 22 })],
    })))

    const doc = new Document({
      styles: { default: { document: { run: { font: 'Helvetica' } } } },
      sections: [{
        properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
        children,
      }],
    })

    const blob = await Packer.toBlob(doc)
    const safeRecip = (nda.recipient_name || 'NDA').replace(/[^a-zA-Z0-9]/g, '_')
    const dateTag = (nda.effective_date || new Date().toISOString().slice(0, 10)).slice(0, 10)
    const prefix = ndaTemplate.filenamePrefix || 'NDA'
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `MarketStreet-${prefix}-${safeRecip}-${dateTag}.docx`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton.Block h="h-24" />
        <Skeleton.Block h="h-64" />
      </div>
    )
  }

  // Guard for template switching mid-edit: switching templates while
  // the body has unsaved edits would replace the body with the new
  // template's build. Warn before doing that.
  const switchTemplate = (id) => {
    if (id === activeTemplate.id) return
    if (editing) {
      const ok = window.confirm(`Switch to ${getTemplate(id).label}? Your edit will be canceled.`)
      if (!ok) return
      setEditing(null)
    }
    if (bodyDirty) {
      const ok = window.confirm(`Switch to ${getTemplate(id).label}? Your customized body will be replaced by the new template.`)
      if (!ok) return
    }
    // Path change also triggers the freshBlankForm bootstrap via
    // activeTemplate re-derivation on the next render.
    setForm(freshBlankForm(getTemplate(id)))
    setBodyDirty(false)
    navigate(`/create-nda/${id}`)
  }

  return (
    <div className="space-y-8">
      {/* Template tab strip — one tab per registered template. Only
          rendered when there's more than one template so a single-
          template deployment doesn't show a redundant control. */}
      {NDA_TEMPLATES.length > 1 && (
        <div className="flex items-center gap-1 border-b border-rule -mb-2">
          {NDA_TEMPLATES.map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => switchTemplate(t.id)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                t.id === activeTemplate.id
                  ? 'border-boom-500 text-boom-700'
                  : 'border-transparent text-gray-500 hover:text-gray-800 hover:border-gray-300'
              }`}
              title={t.description}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      {/* Form + Live Preview */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">
        <div className="bg-card rounded-lg border border-rule shadow-sm p-6">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-lg font-semibold text-gray-900">
              {editing ? `Edit NDA #${editing.id}` : 'New NDA'}
            </h2>
            {editing && (
              <button
                type="button"
                onClick={cancelEdit}
                className="text-xs font-medium text-gray-500 hover:text-gray-700 transition-colors"
              >
                Cancel edit
              </button>
            )}
          </div>
          <p className="text-sm text-gray-500 mb-6">
            {editing
              ? `Editing NDA for ${editing.recipient_name}`
              : 'Fill in the recipient details; Owner / signatory default to market.st.'}
          </p>

          <form data-tour="nda-form" onSubmit={handleCreate} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Effective Date *</label>
              <input
                type="date"
                required
                value={form.effective_date}
                onChange={e => setField('effective_date', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-500 focus:border-boom-500 outline-none"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Owner Name *</label>
                <input
                  type="text"
                  required
                  value={form.owner_name}
                  onChange={e => setField('owner_name', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-500 focus:border-boom-500 outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Owner Address</label>
                <input
                  type="text"
                  value={form.owner_address}
                  onChange={e => setField('owner_address', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-500 focus:border-boom-500 outline-none"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Recipient Name *</label>
                <input
                  type="text"
                  required
                  value={form.recipient_name}
                  onChange={e => setField('recipient_name', e.target.value)}
                  placeholder="Person or company"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-500 focus:border-boom-500 outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Recipient Email <span className="text-gray-400 font-normal">for DocuSign</span></label>
                <input
                  type="email"
                  value={form.recipient_email}
                  onChange={e => setField('recipient_email', e.target.value)}
                  placeholder="name@example.com"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-500 focus:border-boom-500 outline-none"
                  data-recipient-email
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Recipient Address</label>
                <input
                  type="text"
                  value={form.recipient_address}
                  onChange={e => setField('recipient_address', e.target.value)}
                  placeholder="Street, city, state, zip"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-500 focus:border-boom-500 outline-none"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Signatory Name</label>
                <input
                  type="text"
                  value={form.signatory_name}
                  onChange={e => setField('signatory_name', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-500 focus:border-boom-500 outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Signatory Title</label>
                <input
                  type="text"
                  value={form.signatory_title}
                  onChange={e => setField('signatory_title', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-500 focus:border-boom-500 outline-none"
                />
              </div>
            </div>

            {/* Extra fields — each active template can declare
                additional inputs beyond the shared base (project title,
                track name, arbitration venue, etc.). Standard has none. */}
            {(activeTemplate.extraFields || []).length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {activeTemplate.extraFields.map(f => (
                  <div key={f.key} className={f.fullWidth ? 'md:col-span-2' : ''}>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {f.label}{f.required && ' *'}
                    </label>
                    {f.type === 'textarea' ? (
                      <textarea
                        value={form[f.key] || ''}
                        onChange={e => setField(f.key, e.target.value)}
                        rows={f.rows || 3}
                        placeholder={f.placeholder}
                        required={f.required}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-500 focus:border-boom-500 outline-none resize-vertical"
                      />
                    ) : (
                      <input
                        type={f.type || 'text'}
                        value={form[f.key] || ''}
                        onChange={e => setField(f.key, e.target.value)}
                        placeholder={f.placeholder}
                        required={f.required}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-500 focus:border-boom-500 outline-none"
                      />
                    )}
                    {f.description && (
                      <p className="text-[11px] text-gray-500 mt-1">{f.description}</p>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Optional clauses — driven off the active template's
                declared list. Templates with no optional clauses skip
                this section entirely. */}
            {(activeTemplate.optionalClauses || []).length > 0 && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Optional Clauses</label>
                <div className="space-y-2 mb-2">
                  {activeTemplate.optionalClauses.map(c => (
                    <label key={c.key} className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={!!form[c.key]}
                        onChange={e => toggleSection(c.key, e.target.checked)}
                        className="mt-0.5 h-4 w-4 rounded border-gray-300 text-boom-600 focus:ring-boom-500"
                      />
                      <div>
                        <div className="text-sm text-gray-800">{c.label}</div>
                        {c.description && <div className="text-[11px] text-gray-500">{c.description}</div>}
                      </div>
                    </label>
                  ))}
                  {activeTemplate.optionalClauses.every(c => !form[c.key]) && (
                    <div className="text-[11px] text-gray-500 italic pl-6">
                      No optional clauses included — {activeTemplate.label} covers the mandatory sections only.
                    </div>
                  )}
                </div>
              </div>
            )}

            {missingMandatory.length > 0 && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-[12px] text-amber-900 flex items-start gap-2">
                <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
                <div className="flex-1">
                  <div className="font-semibold mb-0.5">Saved body is missing standard sections.</div>
                  <div className="opacity-90">
                    Not present: {missingMandatory.join(', ')}. This NDA was saved against an older template.
                    Click <button type="button" onClick={handleBodyReset} className="underline font-medium hover:text-amber-950">Reset to template</button> to rebuild from the current template (your form-field values are kept; any manual edits to the body are replaced).
                  </div>
                </div>
              </div>
            )}

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-sm font-medium text-gray-700">
                  Body Text {bodyDirty && <span className="text-[11px] font-normal text-amber-700 ml-1">· customized</span>}
                </label>
                <button
                  type="button"
                  onClick={handleBodyReset}
                  className="text-[11px] font-medium text-gray-500 hover:text-gray-800 transition-colors"
                  title="Replace the body with a fresh template build, using the current form values and the current optional-clause toggles. Use this to upgrade an older saved body or to start over after experimenting."
                >
                  Reset to template
                </button>
              </div>
              <textarea
                value={form.custom_body}
                onChange={e => handleBodyChange(e.target.value)}
                rows={18}
                spellCheck={false}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-[12px] font-mono leading-relaxed focus:ring-2 focus:ring-boom-500 focus:border-boom-500 outline-none resize-vertical"
              />
              <p className="text-[11px] text-gray-400 mt-1">
                Edit any section freely. Section headers (lines starting with <code>I.</code> / <code>II.</code> / <code>A.</code>, or all-uppercase titles) render bold in the PDF. The signature block is added automatically at the end — don't include it here.
              </p>
            </div>

            {saveError && (
              <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {saveError}
              </div>
            )}
            {attachedNote && (
              <p className="text-[12px] text-emerald-700 mt-2" data-attached-note>
                {attachedNote.text} <Link to={attachedNote.to} className="underline">Open</Link>
              </p>
            )}
            <button
              type="submit"
              disabled={creating}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-gray-900 text-white text-sm font-medium rounded-lg hover:bg-gray-800 disabled:opacity-50 transition-colors"
            >
              {creating ? <Loader className="animate-spin" size={16} /> : editing ? <Pencil size={16} /> : <Plus size={16} />}
              {editing ? 'Update NDA' : 'Save NDA'}
            </button>
            <p className="text-[11px] text-gray-400 text-center">
              Saving stores the form values; download the PDF from the list below to issue the agreement.
            </p>
          </form>
        </div>

        <div>
          <NDAPreview bodyText={form.custom_body} data={form} template={activeTemplate} />
        </div>
      </div>

      {/* Saved NDAs list */}
      {ndas.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Saved NDAs ({ndas.length})</h2>
          <div className="bg-card rounded-lg border border-rule shadow-sm overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="bg-gray-50 border-b border-rule">
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Effective</th>
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Owner</th>
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Recipient</th>
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Created</th>
                  <th className="text-right text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {ndas.map(nda => (
                  <tr key={nda.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3"><span className="text-sm font-semibold text-gray-900">{formatEffectiveDate((nda.effective_date || '').slice(0, 10))}</span></td>
                    <td className="px-4 py-3"><span className="text-sm text-gray-700">{nda.owner_name}</span></td>
                    <td className="px-4 py-3"><span className="text-sm text-gray-700">{nda.recipient_name}</span></td>
                    <td className="px-4 py-3"><span className="text-xs text-gray-500">{new Date(nda.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} · {nda.created_by || '—'}</span></td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => startEdit(nda)}
                          className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-md transition-colors"
                          title="Edit"
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          onClick={() => setPreviewItem(nda)}
                          className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-md transition-colors"
                          title="Preview"
                        >
                          <Eye size={14} />
                        </button>
                        <button
                          onClick={() => handleDownload(nda)}
                          className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-md transition-colors"
                          title="Download PDF"
                        >
                          <Download size={14} />
                        </button>
                        <SendForSignatureButton docType="nda" docId={nda.id} envelope={envelopes[nda.id]} defaults={{ name: nda.recipient_name, email: nda.recipient_email }}
                          getPdf={() => buildNdaPdf(nda).doc.output('blob')} onChanged={reloadEnvelopes} className="p-1.5 text-gray-400 hover:text-boom-700 hover:bg-boom-50 rounded-md transition-colors" />
                        <button
                          onClick={() => handleDownloadWord(nda)}
                          className="p-1.5 text-gray-400 hover:text-blue-700 hover:bg-blue-50 rounded-md transition-colors text-[10px] font-black leading-none"
                          title="Download Word (.docx)"
                        >
                          W
                        </button>
                        <button
                          onClick={() => handleDelete(nda.id)}
                          className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                          title="Delete"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Preview modal — opened from the eye icon on a saved NDA. */}
      {previewItem && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-8 pb-8 overflow-y-auto bg-overlay" onClick={() => setPreviewItem(null)}>
          <div className="relative w-full max-w-3xl mx-4" onClick={e => e.stopPropagation()}>
            <button
              onClick={() => setPreviewItem(null)}
              className="absolute -top-2 -right-2 z-10 p-1.5 bg-card rounded-full shadow-lg text-gray-400 hover:text-gray-600 transition-colors"
            >
              <X size={16} />
            </button>
            {(() => {
              // Merge template_data JSONB into the row so per-template
              // extras (e.g., recipient_signatory_name) flow into both
              // the body rebuild and the signature-block renderer.
              const t = getTemplate(previewItem.template_id)
              const merged = { ...previewItem, ...(previewItem.template_data || {}) }
              return <NDAPreview bodyText={previewItem.custom_body || t.buildBody(merged)} data={merged} template={t} />
            })()}
            <div className="flex justify-center gap-3 mt-4">
              <button
                onClick={() => handleDownload(previewItem)}
                className="flex items-center gap-2 px-4 py-2 bg-card text-sm font-medium text-gray-700 rounded-lg border border-rule shadow-sm hover:bg-gray-50 transition-colors"
              >
                <Download size={14} /> Download PDF
              </button>
              <button
                onClick={() => handleDownloadWord(previewItem)}
                className="flex items-center gap-2 px-4 py-2 bg-card text-sm font-medium text-gray-700 rounded-lg border border-rule shadow-sm hover:bg-gray-50 transition-colors"
              >
                <FileText size={14} /> Download Word
              </button>
              <button
                onClick={() => setPreviewItem(null)}
                className="flex items-center gap-2 px-4 py-2 bg-gray-900 text-sm font-medium text-white rounded-lg shadow-sm hover:bg-gray-800 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
