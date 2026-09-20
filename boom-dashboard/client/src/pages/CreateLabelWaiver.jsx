import { useState, useEffect } from 'react'
import { Trash2, Download, Plus, Loader, Eye, X, Pencil } from 'lucide-react'
import { jsPDF } from 'jspdf'
import api from '../api'
import Skeleton from '../components/Skeleton'
import useLabel from '../hooks/useLabel'
import { SendForSignatureButton, useEnvelopes } from '../components/SendForSignature'

// Market Street defaults — pre-fill the standing values so most waivers
// only require the deal-specific fields (artist names, song, label,
// release date, royalty %). The COO defaults match the template's
// signature block; override per-document if needed.
// Filled from Settings › Label when the page loads; blank until then.
const BOOM_DEFAULTS = { signatory_name: '', signatory_title: '', contact_email: '' }

const BLANK_FORM = {
  effective_date: '',
  boom_artist: '',
  releasing_label: '',
  other_label_artist: '',
  song_title: '',
  release_date: '',
  release_format: 'single',
  royalty_percent: '',
  contact_email: BOOM_DEFAULTS.contact_email,
  signatory_name: BOOM_DEFAULTS.signatory_name,
  signatory_title: BOOM_DEFAULTS.signatory_title,
  custom_body: '',
}

function formatLongDate(s) {
  if (!s) return ''
  const [y, m, d] = String(s).split('-').map(Number)
  if (!y || !m || !d) return s
  const dt = new Date(y, m - 1, d)
  return dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

// Build the waiver body text. The template is the source of truth:
// substitutions only happen at the spots referenced by form values. The
// returned string drops into the body textarea so users can edit any of
// it. Section headers (LABEL WAIVER REQUEST + the signature block) are
// rendered specially in the preview / PDF — getHeadingLevel decides.
function buildBodyText(form) {
  const boomArtist = (form.boom_artist || 'MARKET STREET ARTIST').trim()
  const label = (form.releasing_label || 'RELEASING LABEL').trim()
  const otherArtist = (form.other_label_artist || 'OTHER LABEL ARTIST').trim()
  const song = (form.song_title || 'SONG').trim()
  const releaseDate = formatLongDate(form.release_date) || 'DATE'
  const format = (form.release_format || 'single').trim()
  const royalty = (form.royalty_percent || 'X').toString().trim()
  const contact = (form.contact_email || BOOM_DEFAULTS.contact_email).trim()
  const sigName = (form.signatory_name || BOOM_DEFAULTS.signatory_name).trim()
  const sigTitle = (form.signatory_title || BOOM_DEFAULTS.signatory_title).trim()

  const paragraphs = [
    `This correspondence shall confirm that Market Street agrees to waive its exclusivity in relation to "${boomArtist}" ("Co-Primary artist") performance on "${label}" ("Label") & "${otherArtist}" ("Artist") recording entitled "${song}" (the "Master"). Market Street has no objection to the release of the recording on one (1) ${format} on ${releaseDate} provided that you agree and accept the following terms.`,
    `• "${label}" shall account to Market Street for ${royalty}% royalties due half-yearly within 90 days of 30th June and 31st December in each year following the release of the Master and shall provide Market Street with detailed statements and calculations. Copies of statements shall be sent to ${contact}.`,
    `• Upon giving not less than four weeks prior notice and no more than once in each calendar year Market Street shall be entitled to inspect ${label}'s books and records of account and to copy relevant extracts to verify the accuracy of payments made to Market Street. Such inspection may be commenced no later than three years after the date of each statement.`,
    `• A courtesy credit shall be provided as follows "${boomArtist} appears courtesy of Market Street."`,
    `• ${label} shall have the right to use Artist's professional name and approved likeness solely for the purposes of promoting and exploiting the Master and the right to credit Artist as a so-called "primary artist" on digital streaming platforms.`,
    `• ${label} shall have the right to third party licensing with mutual written approval from Market Street.`,
    `• ${label} shall have the right to include the recording in any "greatest hits/compilations" with mutual approval from Market Street.`,
    `• ${label} shall have the right to digital exploitation (including ringtone & mastertones) of the recording with mutual written approval from Market Street.`,
    `• ${label} shall have the right to remixes of the recording with mutual approval from Market Street.`,
    `• ${label} shall not have the right to exploit the Master via synchronisation, sample licences, compilations or any other form of licensing without Market Street's prior written approval.`,
    `• ${label} shall not have the right to exploit the Master in any manner except those granted above.`,
    `Please note that the rights granted above are subject to Artist's approval with regard to the use of Artist's performance(s) and their name and/or likeness.`,
    `In the event of a conflict between the terms of this email and any other agreement(s) with Artist, the terms of this agreement shall control.`,
    `Best,`,
    `${sigName}, ${sigTitle}\n${contact}`,
    `LABEL WAIVER REQUEST:`,
    `Artist: ${boomArtist}\nFormat: ${format.toUpperCase()} RELEASE\nRelease date: ${releaseDate}\nPlatforms: all commercial platforms\nTagging/Crediting: Primary Artist, use of name & likeness\nArtist Royalty: ${royalty}% net profits, reporting bi-annual (within 90 days of July 1) via LOD\nLabel: ${label}`,
  ]
  return paragraphs.join('\n\n')
}

// Classifies a paragraph for the renderer. The waiver has fewer special
// blocks than the NDA: just the trailing "LABEL WAIVER REQUEST:" header.
// 0 = body paragraph, 1 = section header (bold).
function getHeadingLevel(para) {
  const t = (para || '').trim()
  if (/^LABEL WAIVER REQUEST:?$/i.test(t)) return 1
  return 0
}

function LabelWaiverPreview({ bodyText, data }) {
  const paragraphs = (bodyText || '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
  return (
    <div className="bg-card rounded-lg border border-rule shadow-sm overflow-hidden">
      <div className="bg-gray-50 px-6 py-3 border-b border-rule">
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Live Preview</h3>
      </div>
      <div className="p-8 max-h-[calc(100vh-220px)] overflow-y-auto space-y-3.5 leading-relaxed">
        <p className="text-[12px] text-gray-500">
          {formatLongDate(data.effective_date) || '____________'}
        </p>
        {paragraphs.map((para, i) => {
          const level = getHeadingLevel(para)
          if (level === 1) {
            return (
              <p key={i} className="text-[13px] font-bold text-gray-900 pt-2">
                {para}
              </p>
            )
          }
          return (
            <p key={i} className="text-[13px] text-gray-700 whitespace-pre-line">
              {para}
            </p>
          )
        })}
      </div>
    </div>
  )
}

function freshBlankForm() {
  const base = { ...BLANK_FORM }
  base.custom_body = buildBodyText(base)
  return base
}

export default function CreateLabelWaiver() {
  const [waivers, setWaivers] = useState([])
  const [envelopes, reloadEnvelopes] = useEnvelopes('waiver')   // DocuSign: latest envelope per waiver
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState(freshBlankForm)
  const label = useLabel()
  useEffect(() => {
    if (!label) return
    const before = { ...BOOM_DEFAULTS }
    BOOM_DEFAULTS.signatory_name = label.signatory_name || ''
    BOOM_DEFAULTS.signatory_title = label.signatory_title || ''
    BOOM_DEFAULTS.contact_email = label.contact_email || ''
    setForm((f) => ({
      ...f,
      signatory_name: (!f.signatory_name || f.signatory_name === before.signatory_name) ? BOOM_DEFAULTS.signatory_name : f.signatory_name,
      signatory_title: (!f.signatory_title || f.signatory_title === before.signatory_title) ? BOOM_DEFAULTS.signatory_title : f.signatory_title,
      contact_email: (!f.contact_email || f.contact_email === before.contact_email) ? BOOM_DEFAULTS.contact_email : f.contact_email,
    }))
  }, [label]) // eslint-disable-line react-hooks/exhaustive-deps
  const [editing, setEditing] = useState(null)
  const [previewItem, setPreviewItem] = useState(null)
  // bodyDirty=true after the user has typed into the body textarea —
  // form-field changes stop auto-overwriting their text. Cleared by
  // "Reset to template" or by starting a fresh form / different waiver.
  const [bodyDirty, setBodyDirty] = useState(false)
  // Roster — fed into a <datalist> so the Market Street Artist input
  // autocompletes to a known artist name. The server uses an
  // exact-name lookup (LOWER(name) match) to attach the generated
  // PDF to the artist's Documents tab; a typo there leaves the
  // file unattached.
  const [artists, setArtists] = useState([])

  const fetchWaivers = async () => {
    try {
      const res = await api.get('/label-waivers')
      setWaivers(res.data.data || [])
    } catch (err) {
      console.error('Label waiver list fetch failed:', err)
    }
  }
  useEffect(() => { fetchWaivers().then(() => setLoading(false)) }, [])
  useEffect(() => {
    api.get('/artists?limit=500')
      .then(r => setArtists(r.data?.data || []))
      .catch(() => {})
  }, [])

  // When the user changes a form field AND hasn't customized the body,
  // rebuild the body from the template. Once they touch the textarea
  // (bodyDirty=true) we stop overwriting until they Reset.
  const setField = (key, value) => {
    setForm(prev => {
      const next = { ...prev, [key]: value }
      if (!bodyDirty && key !== 'custom_body') {
        next.custom_body = buildBodyText(next)
      }
      return next
    })
  }
  const handleBodyChange = (value) => {
    setForm(prev => ({ ...prev, custom_body: value }))
    setBodyDirty(true)
  }
  const handleBodyReset = () => {
    setForm(prev => ({ ...prev, custom_body: buildBodyText(prev) }))
    setBodyDirty(false)
  }

  const startEdit = (w) => {
    setEditing(w)
    const next = {
      effective_date: (w.effective_date || '').slice(0, 10),
      boom_artist: w.boom_artist || '',
      releasing_label: w.releasing_label || '',
      other_label_artist: w.other_label_artist || '',
      song_title: w.song_title || '',
      release_date: (w.release_date || '').slice(0, 10),
      release_format: w.release_format || 'single',
      royalty_percent: w.royalty_percent || '',
      contact_email: w.contact_email || BOOM_DEFAULTS.contact_email,
      signatory_name: w.signatory_name || BOOM_DEFAULTS.signatory_name,
      signatory_title: w.signatory_title || BOOM_DEFAULTS.signatory_title,
      custom_body: w.custom_body || '',
    }
    if (!next.custom_body) next.custom_body = buildBodyText(next)
    setForm(next)
    // Treat a saved body as dirty so later field edits don't clobber it.
    setBodyDirty(!!w.custom_body)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const cancelEdit = () => { setEditing(null); setForm(freshBlankForm()); setBodyDirty(false) }

  const [saveError, setSaveError] = useState('')
  const handleCreate = async (e) => {
    e.preventDefault()
    setSaveError('')
    if (!form.effective_date || !form.boom_artist || !form.releasing_label || !form.song_title) {
      setSaveError('Effective date, Market Street artist, releasing label, and song title are required.')
      return
    }
    setCreating(true)
    try {
      // Generate the PDF up-front so the server can attach it to the
      // artist's Documents tab without a second round-trip. Sent as
      // multipart alongside the form JSON; the server picks `file` off
      // req.file and the form fields off req.body.payload.
      const doc = buildWaiverPDF(form)
      const pdfBlob = doc.output('blob')
      const fd = new FormData()
      fd.append('file', pdfBlob, waiverFilename(form))
      fd.append('payload', JSON.stringify(form))
      const headers = { 'Content-Type': 'multipart/form-data' }
      if (editing) {
        await api.put(`/label-waivers/${editing.id}`, fd, { headers })
        setEditing(null)
      } else {
        await api.post('/label-waivers', fd, { headers })
      }
      setForm(freshBlankForm())
      setBodyDirty(false)
      await fetchWaivers()
    } catch (err) {
      const msg = err?.response?.data?.error || err?.message || 'Save failed'
      setSaveError(msg)
      console.error('Label waiver save failed:', err)
    }
    setCreating(false)
  }

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this label waiver record? This does not revoke any already-issued copies.')) return
    try {
      await api.delete(`/label-waivers/${id}`)
      await fetchWaivers()
    } catch { /* ignore */ }
  }

  // Build the jsPDF document from a waiver row. Separated from
  // handleDownload so handleCreate can also use it to ship the PDF
  // alongside the form values on save — that's how the file ends up
  // on the artist's Documents tab.
  const buildWaiverPDF = (w) => {
    const doc = new jsPDF({ unit: 'pt', format: 'letter' })
    const W = doc.internal.pageSize.getWidth()
    const H = doc.internal.pageSize.getHeight()
    const MX = 72
    const MY = 72
    const lineH = 14
    const bodyW = W - MX * 2
    let y = MY

    const ensureSpace = (need = lineH) => {
      if (y + need > H - MY) { doc.addPage(); y = MY }
    }

    // Header date.
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(11)
    doc.setTextColor(120, 120, 120)
    doc.text(formatLongDate(w.effective_date) || '____________', MX, y)
    y += lineH + 8

    const bodyText = w.custom_body || buildBodyText(w)
    const paragraphs = bodyText.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
    paragraphs.forEach(para => {
      const level = getHeadingLevel(para)
      if (level === 1) {
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
    return doc
  }

  // Canonical filename used both by direct download + the attached file
  // on entity_files. Kept consistent so a user who downloads the PDF
  // ends up with the same name they'd see on the artist's Documents tab.
  const waiverFilename = (w) => {
    const safe = (s) => (s || 'untitled').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)
    const dateTag = (w.effective_date || '').slice(0, 10) || new Date().toISOString().slice(0, 10)
    return `MarketStreet-LabelWaiver-${safe(w.boom_artist)}-${safe(w.song_title)}-${dateTag}.pdf`
  }

  const handleDownload = (w) => {
    const doc = buildWaiverPDF(w)
    doc.save(waiverFilename(w))
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton.Block h="h-24" />
        <Skeleton.Block h="h-64" />
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">
        <div className="bg-card rounded-lg border border-rule shadow-sm p-6">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-lg font-semibold text-gray-900">
              {editing ? `Edit Waiver #${editing.id}` : 'New Label Waiver'}
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
              ? `Editing waiver for ${editing.boom_artist} on ${editing.releasing_label}`
              : 'Fill in the deal-specific fields; signatory + contact email default to Market Street.'}
          </p>

          <form onSubmit={handleCreate} className="space-y-4">
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
                <label className="block text-sm font-medium text-gray-700 mb-1">Market Street Artist *</label>
                <input
                  type="text"
                  required
                  list="marketst-artist-roster"
                  value={form.boom_artist}
                  onChange={e => setField('boom_artist', e.target.value)}
                  placeholder="The Market Street-signed artist featured"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-500 focus:border-boom-500 outline-none"
                />
                <datalist id="marketst-artist-roster">
                  {artists.map(a => <option key={a.id} value={a.name} />)}
                </datalist>
                <p className="text-[10px] text-gray-400 mt-0.5">
                  Pick a name from the roster so the saved PDF attaches to the artist's Documents tab.
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Releasing Label *</label>
                <input
                  type="text"
                  required
                  value={form.releasing_label}
                  onChange={e => setField('releasing_label', e.target.value)}
                  placeholder="Label issuing the release"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-500 focus:border-boom-500 outline-none"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Other Label's Artist</label>
                <input
                  type="text"
                  value={form.other_label_artist}
                  onChange={e => setField('other_label_artist', e.target.value)}
                  placeholder="Primary artist on the releasing label"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-500 focus:border-boom-500 outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Song Title *</label>
                <input
                  type="text"
                  required
                  value={form.song_title}
                  onChange={e => setField('song_title', e.target.value)}
                  placeholder="The Master"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-500 focus:border-boom-500 outline-none"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Release Date</label>
                <input
                  type="date"
                  value={form.release_date}
                  onChange={e => setField('release_date', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-500 focus:border-boom-500 outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Format</label>
                <select
                  value={form.release_format}
                  onChange={e => setField('release_format', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-500 focus:border-boom-500 outline-none bg-white"
                >
                  <option value="single">single</option>
                  <option value="EP">EP</option>
                  <option value="album">album</option>
                  <option value="mixtape">mixtape</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Royalty %</label>
                <input
                  type="text"
                  value={form.royalty_percent}
                  onChange={e => setField('royalty_percent', e.target.value)}
                  placeholder="e.g. 25"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-500 focus:border-boom-500 outline-none"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
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
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Contact Email</label>
                <input
                  type="email"
                  value={form.contact_email}
                  onChange={e => setField('contact_email', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-500 focus:border-boom-500 outline-none"
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-sm font-medium text-gray-700">
                  Body Text {bodyDirty && <span className="text-[11px] font-normal text-amber-700 ml-1">· customized</span>}
                </label>
                <button
                  type="button"
                  onClick={handleBodyReset}
                  className="text-[11px] font-medium text-gray-500 hover:text-gray-800 transition-colors"
                  title="Replace the body with a fresh template build using the current form values. Use this to upgrade an older saved body or to start over after experimenting."
                >
                  Reset to template
                </button>
              </div>
              <textarea
                value={form.custom_body}
                onChange={e => handleBodyChange(e.target.value)}
                rows={16}
                spellCheck={false}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-[12px] font-mono leading-relaxed focus:ring-2 focus:ring-boom-500 focus:border-boom-500 outline-none resize-vertical"
              />
              <p className="text-[11px] text-gray-400 mt-1">
                Edit freely. Form-field changes auto-update the body until you start typing here — then the body stays exactly as you left it. Use "Reset to template" to regenerate.
              </p>
            </div>

            {saveError && (
              <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {saveError}
              </div>
            )}
            <button
              type="submit"
              disabled={creating}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-gray-900 text-white text-sm font-medium rounded-lg hover:bg-gray-800 disabled:opacity-50 transition-colors"
            >
              {creating ? <Loader className="animate-spin" size={16} /> : editing ? <Pencil size={16} /> : <Plus size={16} />}
              {editing ? 'Update Waiver' : 'Save Waiver'}
            </button>
            <p className="text-[11px] text-gray-400 text-center">
              Saving stores the form values; download the PDF from the list below to issue the waiver.
            </p>
          </form>
        </div>

        <div>
          <LabelWaiverPreview bodyText={form.custom_body} data={form} />
        </div>
      </div>

      {waivers.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Saved Waivers ({waivers.length})</h2>
          <div className="bg-card rounded-lg border border-rule shadow-sm overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="bg-gray-50 border-b border-rule">
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Effective</th>
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Market Street Artist</th>
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Song</th>
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Label</th>
                  <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Created</th>
                  <th className="text-right text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {waivers.map(w => (
                  <tr key={w.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3"><span className="text-sm font-semibold text-gray-900">{formatLongDate((w.effective_date || '').slice(0, 10))}</span></td>
                    <td className="px-4 py-3"><span className="text-sm text-gray-700">{w.boom_artist}</span></td>
                    <td className="px-4 py-3"><span className="text-sm text-gray-700">{w.song_title}</span></td>
                    <td className="px-4 py-3"><span className="text-sm text-gray-700">{w.releasing_label}</span></td>
                    <td className="px-4 py-3"><span className="text-xs text-gray-500">{new Date(w.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} · {w.created_by || '—'}</span></td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => startEdit(w)} className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-md transition-colors" title="Edit">
                          <Pencil size={14} />
                        </button>
                        <button onClick={() => setPreviewItem(w)} className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-md transition-colors" title="Preview">
                          <Eye size={14} />
                        </button>
                        <button onClick={() => handleDownload(w)} className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-md transition-colors" title="Download PDF">
                          <Download size={14} />
                        </button>
                        <SendForSignatureButton docType="waiver" docId={w.id} envelope={envelopes[w.id]} defaults={{ name: w.other_label_artist || w.releasing_label, email: w.contact_email }}
                          getPdf={() => buildWaiverPDF(w).output('blob')} onChanged={reloadEnvelopes} className="p-1.5 text-gray-400 hover:text-boom-700 hover:bg-boom-50 rounded-md transition-colors" />
                        <button onClick={() => handleDelete(w.id)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors" title="Delete">
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

      {previewItem && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-8 pb-8 overflow-y-auto bg-overlay" onClick={() => setPreviewItem(null)}>
          <div className="relative w-full max-w-3xl mx-4" onClick={e => e.stopPropagation()}>
            <button onClick={() => setPreviewItem(null)} className="absolute -top-2 -right-2 z-10 p-1.5 bg-card rounded-full shadow-lg text-gray-400 hover:text-gray-600 transition-colors">
              <X size={16} />
            </button>
            <LabelWaiverPreview bodyText={previewItem.custom_body || buildBodyText(previewItem)} data={previewItem} />
            <div className="flex justify-center gap-3 mt-4">
              <button onClick={() => handleDownload(previewItem)} className="flex items-center gap-2 px-4 py-2 bg-card text-sm font-medium text-gray-700 rounded-lg border border-rule shadow-sm hover:bg-gray-50 transition-colors">
                <Download size={14} /> Download PDF
              </button>
              <button onClick={() => setPreviewItem(null)} className="flex items-center gap-2 px-4 py-2 bg-gray-900 text-sm font-medium text-white rounded-lg shadow-sm hover:bg-gray-800 transition-colors">
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
