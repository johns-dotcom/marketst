import { useState, useRef, useEffect } from 'react'
import { Upload, Loader, AlertCircle, CheckCircle, Plus, Trash2, AlertTriangle, AtSign } from 'lucide-react'
import api from '../api'
import PageHeader from '../components/PageHeader'
import useUnsavedWarning from '../hooks/useUnsavedWarning'
import { CATEGORIES, PAYMENT_METHODS, SOCIAL_PLATFORMS } from '../constants'
import { useCategories } from '../context/CategoriesContext'
import { useBoomReps } from '../context/BoomRepsContext'
import { useAuth } from '../context/AuthContext'

export default function BkAddReimbursement() {
  // Live expense categories. Bound to the same name the module-level
  // import used, so every CATEGORIES reference in this component now
  // reads the vocabulary from context (which falls back to that same
  // constant if the fetch fails). Categories are user-created on the
  // Statements and Reports pages — a hardcoded list here would leave
  // this dropdown unable to render its own rows' values.
  const CATEGORIES = useCategories()
  const { user } = useAuth()
  // Same admin-level set as the Add Invoice page (and the server's
  // isBkAdmin): Admin / Superadmin / Approver submit with the fast path;
  // everyone else must supply at least one social handle.
  const role = (user?.role || '').toLowerCase()
  const isAdminLevel = role === 'admin' || role === 'superadmin' || role === 'approver'
  const BOOM_REPS = useBoomReps()
  const receiptInputRef = useRef(null)
  const [dragActive, setDragActive] = useState(false)
  const [receiptFiles, setReceiptFiles] = useState([])
  const [parseFile, setParseFile] = useState(null) // which receipt to parse
  const [parsing, setParsing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  const [proofFile, setProofFile] = useState(null)
  const [invoiceFile, setInvoiceFile] = useState(null)

  const [form, setForm] = useState({
    invoice_date: '',
    payee: '',
    vendor_email: '',
    description: '',
    category: '',
    artist: '',
    song: '',
    invoice_number: '',
    amount: '',
    currency: 'USD',
    payment_method: '',
    boom_rep: '',
    notes: '',
    payment_status: 'Unpaid',
    payment_date: '', payment_ref: ''
  })
  const [parsingProof, setParsingProof] = useState(false)
  // Social handles editor — same shape + JSONB social_handles column as
  // the Add Invoice page, so reimbursed creator/influencer rows carry
  // their socials into the Marketing / PR reconciliation views too.
  const [socialRows, setSocialRows] = useState([{ platform: 'Instagram', handle: '', artist: '', amount: '' }])
  const addSocialRow    = () => setSocialRows(prev => [...prev, { platform: 'Instagram', handle: '', artist: '', amount: '' }])
  const removeSocialRow = (i) => setSocialRows(prev => prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev)
  const updateSocialRow = (i, key, val) => setSocialRows(prev => prev.map((r, idx) => idx === i ? { ...r, [key]: val } : r))

  const [splitEnabled, setSplitEnabled] = useState(false)

  useUnsavedWarning(!!form.payee || !!form.amount || !!form.description || !!invoiceFile)
  const [artistSplits, setArtistSplits] = useState([{ artist: '', song: '', amount: '' }])
  const [dupWarning, setDupWarning] = useState(null)
  // Distinct artists currently typed into the split editor — feeds the
  // per-handle "For artist" tag on the socials editor below. Declared
  // AFTER artistSplits (const, so referencing it earlier would throw).
  const splitArtistOptions = splitEnabled
    ? [...new Set(artistSplits.map(s => (s.artist || '').trim()).filter(Boolean))]
    : []

  useEffect(() => {
    if (!form.payee || !form.invoice_number) { setDupWarning(null); return }
    const timer = setTimeout(async () => {
      try {
        const res = await api.get('/bk/check-dup', { params: { payee: form.payee, invoice_number: form.invoice_number } })
        setDupWarning(res.data.duplicate ? res.data.entry : null)
      } catch { setDupWarning(null) }
    }, 500)
    return () => clearTimeout(timer)
  }, [form.payee, form.invoice_number])

  const handleDrag = (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.type === 'dragenter' || e.type === 'dragover') setDragActive(true)
    else if (e.type === 'dragleave') setDragActive(false)
  }

  const addReceiptFile = (f) => {
    if (['application/pdf', 'image/jpeg', 'image/png'].includes(f.type)) {
      setReceiptFiles(prev => [...prev, f])
      setError('')
    } else {
      setError('Only PDF, JPG, and PNG files are supported')
    }
  }

  const handleDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)
    const files = Array.from(e.dataTransfer.files || [])
    files.forEach(addReceiptFile)
  }

  const handleFileChange = (e) => {
    const files = Array.from(e.target.files || [])
    files.forEach(addReceiptFile)
    e.target.value = ''
  }

  const handleParse = async (overrideFile) => {
    const fileToParse = overrideFile || parseFile || receiptFiles[0]
    if (!fileToParse) return
    try {
      setParsing(true)
      setError('')
      const formData = new FormData()
      formData.append('file', fileToParse)
      const res = await api.post('/bk/parse', formData, { headers: { 'Content-Type': 'multipart/form-data' } })
      const data = res.data.data
      setForm(prev => ({
        ...prev,
        invoice_date: data.invoice_date || prev.invoice_date,
        payee: data.payee || prev.payee,
        amount: data.amount || prev.amount,
        invoice_number: data.invoice_number || prev.invoice_number,
        category: data.category || prev.category,
        payment_method: data.payment_method || prev.payment_method,
        artist: data.artist || prev.artist,
        song: data.song || prev.song,
        description: data.description || prev.description,
        currency: data.currency || prev.currency,
      }))
      setToast('AI parsing completed')
      setTimeout(() => setToast(''), 3000)
    } catch (err) {
      setError('Failed to parse file: ' + (err.response?.data?.error || err.message))
    } finally { setParsing(false) }
  }

  const handleProofUpload = async (file) => {
    setProofFile(file)
    setForm(prev => ({ ...prev, payment_status: 'Paid' }))
    if (file) {
      setParsingProof(true)
      try {
        const fd = new FormData()
        fd.append('file', file)
        const res = await api.post('/bk/parse-proof', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
        const data = res.data.data
        if (data?.payment_date) {
          setForm(prev => ({ ...prev, payment_date: data.payment_date }))
          setToast(`AI detected payment date: ${data.payment_date}`)
          setTimeout(() => setToast(''), 4000)
        }
        if (data?.payment_method) {
          // Check inside the updater — the closure's `form` predates the
          // scan, so a method the user picked mid-scan got clobbered.
          setForm(prev => prev.payment_method ? prev : { ...prev, payment_method: data.payment_method })
        }
        if (data?.reference_number) {
          setForm(prev => ({ ...prev, payment_ref: data.reference_number }))
        }
      } catch (_) {}
      finally { setParsingProof(false) }
    }
  }

  const handleFormChange = (field, value) => setForm(prev => ({ ...prev, [field]: value }))

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!form.payee || !form.amount || !form.invoice_date) {
      setError('Payee, amount, and date are required')
      return
    }
    const email = (form.vendor_email || '').trim()
    if (!email) {
      setError('Vendor email is required')
      return
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('Please enter a valid vendor email address')
      return
    }
    if (!isAdminLevel && !socialRows.some(r => (r.handle || '').trim())) {
      setError('At least one social media handle is required')
      return
    }
    try {
      setSaving(true)
      setError('')
      const payload = {
        ...form,
        amount: parseFloat(form.amount),
        is_reimbursement: true,
      }
      // Socials — send only rows with a real handle; same JSON shape the
      // Add Invoice page sends. An artist tag scopes the handle to one
      // artist of a split invoice; untagged handles are shared family-wide
      // (matches the Artist Campaigns display filter).
      const validSocials = socialRows
        .map(r => {
          const platform = (r.platform || '').trim()
          const handle = (r.handle || '').trim()
          const artist = (r.artist || '').trim()
          if (!handle) return null
          const row = { platform, handle }
          if (artist) row.artist = artist
          const amountNum = parseFloat(r.amount)
          if (Number.isFinite(amountNum) && amountNum > 0) row.amount = amountNum
          return row
        })
        .filter(Boolean)
      if (validSocials.length) payload.social_handles = validSocials
      if (splitEnabled) {
        const validSplits = artistSplits.filter(s => s.artist && s.amount)
        if (validSplits.length) {
          payload.artist_breakdown = validSplits.map(s => ({
            artist: s.artist, song: s.song, amount: parseFloat(s.amount)
          }))
          if (!payload.artist && validSplits[0].artist) payload.artist = validSplits[0].artist
        }
      }
      const res = await api.post('/bk/entries', payload)
      const entryId = res.data.data?.id

      if (entryId) {
        const uploadSingle = async (f, type) => {
          const fd = new FormData()
          fd.append('file', f)
          await api.post(`/bk/entries/${entryId}/file/${type}`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
        }
        // Upload multiple receipts via entity_files
        for (const rf of receiptFiles) {
          const fd = new FormData()
          fd.append('file', rf)
          await api.post(`/bk/entries/${entryId}/receipts`, fd, { headers: { 'Content-Type': 'multipart/form-data' } }).catch(() => {})
        }
        if (invoiceFile) await uploadSingle(invoiceFile, 'invoice').catch(() => {})
        if (proofFile) await uploadSingle(proofFile, 'proof').catch(() => {})
      }

      setForm({
        invoice_date: '', payee: '', vendor_email: '', description: '', category: '', artist: '', song: '',
        invoice_number: '', amount: '', currency: 'USD', payment_method: '', boom_rep: '',
        notes: '', payment_status: 'Unpaid', payment_date: '', payment_ref: ''
      })
      setSplitEnabled(false)
      setArtistSplits([{ artist: '', song: '', amount: '' }])
      setSocialRows([{ platform: 'Instagram', handle: '', artist: '', amount: '' }])
      setReceiptFiles([])
      setParseFile(null)
      setInvoiceFile(null)
      setProofFile(null)
      setSuccess(true)
      setTimeout(() => setSuccess(false), 5000)
    } catch (err) {
      setError('Failed to save: ' + (err.response?.data?.error || err.message))
    } finally { setSaving(false) }
  }

  return (
    <div className="min-h-screen bg-surface-50 p-6">
      <div className="max-w-3xl mx-auto">
        <PageHeader tour="reimburse-header" title="Add Reimbursement" subtitle="Submit receipts and reimbursement requests" />

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-lg mb-6 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 mt-0.5 flex-shrink-0" />
            <div><p className="font-medium">Error</p><p className="text-sm">{error}</p></div>
          </div>
        )}

        {toast && (
          <div className="bg-blue-50 border border-blue-200 text-blue-800 px-4 py-3 rounded-lg mb-6">{toast}</div>
        )}

        {success && (
          <div className="bg-green-50 border border-green-200 text-green-800 px-4 py-3 rounded-lg mb-6 flex items-start gap-3">
            <CheckCircle className="w-5 h-5 mt-0.5 flex-shrink-0" />
            <div><p className="font-medium">Reimbursement saved successfully!</p></div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Invoice upload (primary — parseable) */}
          <div data-tour="reimburse-upload"
            className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition ${
              dragActive ? 'border-boom-600 bg-boom-50'
                : invoiceFile ? 'border-green-400 bg-green-50'
                : 'border-gray-300 bg-card hover:border-gray-400'
            }`}
            onDragEnter={handleDrag} onDragLeave={handleDrag} onDragOver={handleDrag}
            onDrop={e => { e.preventDefault(); e.stopPropagation(); setDragActive(false); if (e.dataTransfer.files?.[0]) setInvoiceFile(e.dataTransfer.files[0]) }}
            onClick={() => {
              const input = document.createElement('input')
              input.type = 'file'; input.accept = '.pdf,.jpg,.jpeg,.png'
              input.onchange = ev => { if (ev.target.files?.[0]) setInvoiceFile(ev.target.files[0]) }
              input.click()
            }}
          >
            {invoiceFile ? (
              <div className="text-green-600">
                <CheckCircle className="w-8 h-8 mx-auto mb-2" />
                <p className="font-medium">{invoiceFile.name}</p>
                <p className="text-sm text-green-500">Ready to parse</p>
              </div>
            ) : (
              <div className="text-gray-600">
                <Upload className="w-8 h-8 mx-auto mb-2 text-gray-400" />
                <p className="font-medium">Drag or click to upload invoice</p>
                <p className="text-sm text-gray-500 mt-1">PDF, JPG, or PNG</p>
              </div>
            )}
          </div>

          {invoiceFile && (
            <div className="flex gap-2">
              <button type="button" onClick={() => handleParse(invoiceFile)} disabled={parsing}
                className="flex-1 px-4 py-3 bg-boom-600 text-white rounded-lg hover:bg-boom-700 disabled:opacity-50 flex items-center justify-center gap-2">
                {parsing && <Loader className="w-4 h-4 animate-spin" />}
                {parsing ? 'Parsing with AI...' : 'Parse Invoice with AI'}
              </button>
              <button type="button" onClick={() => setInvoiceFile(null)}
                className="px-4 py-3 text-sm font-medium text-gray-500 border border-rule rounded-lg hover:bg-gray-50">
                Remove
              </button>
            </div>
          )}

          {/* Receipts + Proof uploads */}
          <div className="grid grid-cols-2 gap-4">
            {/* Receipts (multiple) */}
            <div
              className={`border-2 border-dashed rounded-lg p-5 text-center cursor-pointer transition ${
                receiptFiles.length > 0 ? 'border-green-400 bg-green-50' : 'border-gray-300 bg-card hover:border-gray-400'
              }`}
              onClick={() => receiptInputRef.current?.click()}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); Array.from(e.dataTransfer.files || []).forEach(addReceiptFile) }}
            >
              <input ref={receiptInputRef} type="file" hidden accept=".pdf,.jpg,.jpeg,.png" multiple onChange={handleFileChange} />
              {receiptFiles.length > 0 ? (
                <div className="text-green-600">
                  <CheckCircle className="w-6 h-6 mx-auto mb-1" />
                  <p className="text-sm font-medium">{receiptFiles.length} receipt{receiptFiles.length !== 1 ? 's' : ''}</p>
                  <button type="button" onClick={e => { e.stopPropagation(); setReceiptFiles([]) }} className="text-xs text-red-500 mt-1 hover:underline">Clear all</button>
                </div>
              ) : (
                <div className="text-gray-500">
                  <Upload className="w-6 h-6 mx-auto mb-1 text-gray-400" />
                  <p className="text-sm font-medium">Receipts</p>
                  <p className="text-xs text-gray-400">Multiple files OK</p>
                </div>
              )}
            </div>

            {/* Proof of payment */}
          <div
            className={`border-2 border-dashed rounded-lg p-5 text-center cursor-pointer transition ${
              proofFile ? 'border-green-400 bg-green-50' : 'border-gray-300 bg-card hover:border-gray-400'
            }`}
            onClick={() => {
              const input = document.createElement('input')
              input.type = 'file'; input.accept = '.pdf,.jpg,.jpeg,.png'
              input.onchange = e => { if (e.target.files?.[0]) handleProofUpload(e.target.files[0]) }
              input.click()
            }}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); if (e.dataTransfer.files?.[0]) handleProofUpload(e.dataTransfer.files[0]) }}
          >
            {proofFile ? (
              <div className="text-green-600">
                <CheckCircle className="w-6 h-6 mx-auto mb-1" />
                <p className="text-sm font-medium truncate">{proofFile.name}</p>
                {parsingProof && <p className="text-xs text-blue-500 mt-1 animate-pulse">Scanning for payment date...</p>}
                <button type="button" onClick={e => { e.stopPropagation(); setProofFile(null); setForm(prev => ({ ...prev, payment_status: 'Unpaid', payment_date: '', payment_ref: '' })) }} className="text-xs text-red-500 mt-1 hover:underline">Remove</button>
              </div>
            ) : (
              <div className="text-gray-500">
                <Upload className="w-6 h-6 mx-auto mb-1 text-gray-400" />
                <p className="text-sm font-medium">Proof of Payment</p>
                <p className="text-xs text-gray-400">Auto-marks as paid</p>
              </div>
            )}
          </div>
          </div>

          {/* Form fields */}
          <div data-tour="reimburse-fields" className="bg-card rounded-lg shadow p-6 space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Date *</label>
                <input type="date" required value={form.invoice_date}
                  onChange={e => handleFormChange('invoice_date', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-boom-600 focus:border-transparent" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Paid To *</label>
                <input type="text" required value={form.payee}
                  onChange={e => handleFormChange('payee', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-boom-600 focus:border-transparent" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Vendor Email *</label>
                <input type="email" required value={form.vendor_email}
                  onChange={e => handleFormChange('vendor_email', e.target.value)}
                  placeholder="vendor@example.com"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-boom-600 focus:border-transparent" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                <select value={form.category} onChange={e => handleFormChange('category', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-boom-600 focus:border-transparent">
                  <option value="">Select category</option>
                  {CATEGORIES.map(cat => <option key={cat} value={cat}>{cat}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Artist</label>
                <input type="text" value={form.artist}
                  onChange={e => handleFormChange('artist', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-boom-600 focus:border-transparent" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Song</label>
                <input type="text" value={form.song}
                  onChange={e => handleFormChange('song', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-boom-600 focus:border-transparent" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Invoice #</label>
                <input type="text" value={form.invoice_number}
                  onChange={e => handleFormChange('invoice_number', e.target.value)}
                  className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-boom-600 focus:border-transparent ${dupWarning ? 'border-amber-400 bg-amber-50' : 'border-gray-300'}`} />
                {dupWarning && (
                  <div className="flex items-start gap-2 mt-1.5 text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                    <p className="text-xs">
                      Invoice <strong>#{form.invoice_number}</strong> already on file for <strong>{form.payee}</strong>
                      {dupWarning.amount && <> — {Number(dupWarning.amount).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}</>}
                      {dupWarning.payment_status && <> ({dupWarning.payment_status})</>}
                    </p>
                  </div>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Amount *</label>
                <input type="number" step="0.01" required value={form.amount}
                  onChange={e => handleFormChange('amount', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-boom-600 focus:border-transparent" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Currency</label>
                <select value={form.currency} onChange={e => handleFormChange('currency', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-boom-600 focus:border-transparent">
                  <option value="USD">USD</option><option value="EUR">EUR</option><option value="GBP">GBP</option><option value="CAD">CAD</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Payment Method</label>
                <select value={form.payment_method} onChange={e => handleFormChange('payment_method', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-boom-600 focus:border-transparent">
                  <option value="">Select method</option>
                  {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">market.st Rep</label>
                <select value={form.boom_rep}
                  onChange={e => handleFormChange('boom_rep', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-boom-600 focus:border-transparent bg-white">
                  <option value="">Select rep</option>
                  {BOOM_REPS.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
            </div>

            {/* Artist Split */}
            <div>
              <label className="flex items-center gap-2 cursor-pointer mb-2">
                <input type="checkbox" checked={splitEnabled} onChange={e => setSplitEnabled(e.target.checked)} className="rounded border-gray-300" />
                <span className="text-sm font-medium text-gray-700">Split between multiple artists</span>
              </label>
              {splitEnabled && (
                <div className="bg-gray-50 rounded-lg p-4 space-y-2">
                  {artistSplits.map((split, idx) => (
                    <div key={idx} className="flex gap-2 items-start">
                      <input type="text" value={split.artist}
                        onChange={e => setArtistSplits(prev => prev.map((s, i) => i === idx ? { ...s, artist: e.target.value } : s))}
                        placeholder="Artist" className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-600 focus:border-transparent" />
                      <input type="text" value={split.song}
                        onChange={e => setArtistSplits(prev => prev.map((s, i) => i === idx ? { ...s, song: e.target.value } : s))}
                        placeholder="Song (optional)" className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-600 focus:border-transparent" />
                      <input type="number" step="0.01" min="0" value={split.amount}
                        onChange={e => setArtistSplits(prev => prev.map((s, i) => i === idx ? { ...s, amount: e.target.value } : s))}
                        placeholder="Amount" className="w-28 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-600 focus:border-transparent" />
                      {artistSplits.length > 1 && (
                        <button type="button" onClick={() => setArtistSplits(prev => prev.filter((_, i) => i !== idx))}
                          className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors">
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  ))}
                  <div className="flex items-center justify-between pt-1">
                    <button type="button" onClick={() => setArtistSplits(prev => [...prev, { artist: '', song: '', amount: '' }])}
                      className="flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-700 transition-colors">
                      <Plus size={13} /> Add artist
                    </button>
                    {artistSplits.filter(s => s.amount).length > 0 && (() => {
                      const splitSum = artistSplits.reduce((s, sp) => s + parseFloat(sp.amount || 0), 0);
                      const total = parseFloat(form.amount || 0);
                      const remaining = total - splitSum;
                      const balanced = Math.abs(remaining) < 0.01;
                      return (
                        <span className={`text-xs font-medium ${balanced ? 'text-green-600' : 'text-amber-600'}`}>
                          Split total: ${splitSum.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                          {form.amount && !balanced && (
                            <> (total: ${total.toLocaleString('en-US', { minimumFractionDigits: 2 })}, {remaining >= 0 ? 'remaining' : 'over by'}: ${Math.abs(remaining).toLocaleString('en-US', { minimumFractionDigits: 2 })})</>
                          )}
                        </span>
                      );
                    })()}
                  </div>
                </div>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <textarea value={form.description} onChange={e => handleFormChange('description', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-boom-600 focus:border-transparent" rows="3" />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
              <textarea value={form.notes} onChange={e => handleFormChange('notes', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-boom-600 focus:border-transparent" rows="2" />
            </div>

            {/* Social handles — same editor as the Add Invoice page. Stored
                on the JSONB social_handles column so reimbursed creator /
                influencer rows surface with real socials in Flags →
                Missing Socials and the campaign reconciliation views. */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-gray-700 flex items-center gap-1.5">
                  <AtSign size={14} className="text-gray-400" />
                  Social Handles{!isAdminLevel && ' *'}
                  <span className="text-xs font-normal text-gray-400">
                    {isAdminLevel ? '— optional, for creator / influencer rows' : '— required, at least one handle'}
                  </span>
                </label>
              </div>
              <div className="space-y-2">
                {socialRows.map((row, i) => (
                  <div key={i} className="flex gap-2 items-start">
                    <select
                      value={row.platform}
                      onChange={e => updateSocialRow(i, 'platform', e.target.value)}
                      className="w-40 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-600 focus:border-transparent bg-white"
                    >
                      {SOCIAL_PLATFORMS.map(p => <option key={p} value={p}>{p}</option>)}
                    </select>
                    <input
                      type="text"
                      value={row.handle}
                      onChange={e => updateSocialRow(i, 'handle', e.target.value)}
                      placeholder="@handle"
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-600 focus:border-transparent"
                    />
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={row.amount || ''}
                      onChange={e => updateSocialRow(i, 'amount', e.target.value)}
                      placeholder="$"
                      title="Amount paid to this creator (optional)"
                      className="w-24 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-600 focus:border-transparent"
                    />
                    {/* Per-handle artist tag — only when the invoice is split
                        across 2+ artists. Untagged = shared across all of
                        them (same rule the Artist Campaigns page displays by). */}
                    {splitArtistOptions.length > 1 && (
                      <select
                        value={row.artist || ''}
                        onChange={e => updateSocialRow(i, 'artist', e.target.value)}
                        title="Which artist this handle belongs to — leave on All artists to share it across the split"
                        className="w-44 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-600 focus:border-transparent bg-white"
                      >
                        <option value="">All artists</option>
                        {splitArtistOptions.map(a => <option key={a} value={a}>{a}</option>)}
                      </select>
                    )}
                    {socialRows.length > 1 ? (
                      <button
                        type="button"
                        onClick={() => removeSocialRow(i)}
                        className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                        title="Remove this handle"
                      >
                        <Trash2 size={14} />
                      </button>
                    ) : (
                      <div className="w-9" />
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addSocialRow}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold text-gray-500 hover:text-boom-600 hover:bg-boom-50 transition-colors"
                >
                  <Plus size={12} /> Add another handle
                </button>
              </div>
            </div>

            {/* Payment status */}
            <div className="flex items-start gap-6 flex-wrap">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.payment_status === 'Paid'}
                  onChange={e => handleFormChange('payment_status', e.target.checked ? 'Paid' : 'Unpaid')}
                  className="rounded border-gray-300 text-green-600 focus:ring-green-500" />
                <span className="text-sm font-medium text-gray-700">Mark as Paid</span>
              </label>
              {form.payment_status === 'Paid' && (
                <>
                <div className="flex items-center gap-2">
                  <label className="text-sm text-gray-500">Date Paid</label>
                  <input type="date" value={form.payment_date}
                    onChange={e => handleFormChange('payment_date', e.target.value)}
                    className="px-2 py-1 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-600 focus:border-transparent" />
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-sm text-gray-500">Ref #</label>
                  <input type="text" value={form.payment_ref}
                    onChange={e => handleFormChange('payment_ref', e.target.value)}
                    placeholder="Check #, wire ref, etc."
                    className="px-2 py-1 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-600 focus:border-transparent w-44" />
                </div>
              </>
              )}
            </div>
          </div>

          <button data-tour="reimburse-submit" type="submit" disabled={saving}
            className="w-full px-6 py-3 bg-boom-600 text-white rounded-lg hover:bg-boom-700 disabled:opacity-50 font-medium flex items-center justify-center gap-2">
            {saving && <Loader className="w-4 h-4 animate-spin" />}
            {saving ? 'Saving...' : 'Save Reimbursement'}
          </button>
        </form>
      </div>
    </div>
  )
}
