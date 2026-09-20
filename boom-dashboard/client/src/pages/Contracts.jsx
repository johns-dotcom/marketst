import { useState, useEffect, useRef } from 'react'
import { Search, Upload, File, ArrowLeft, AlertTriangle, UserX, FileX, Clock, ChevronDown, ChevronUp, X, Bell, Plus, Sparkles, CheckCircle2, ExternalLink, Eye, Trash2, PiggyBank, Music2, DollarSign, BarChart3, TrendingUp, ChevronRight } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import api from '../api'
import { formatDate, getFileUrl } from '../utils'
import FilesPanel from '../components/FilesPanel'
import FilePreview from '../components/FilePreview'
import Skeleton from '../components/Skeleton'
import useHotkeys from '../hooks/useHotkeys'
import PageHeader from '../components/PageHeader'
import SearchableSelect from '../components/SearchableSelect'
import NextStepPrompt, { useNextStep } from '../components/NextStepPrompt'
import { SendForSignatureButton, useEnvelopes } from '../components/SendForSignature'

// A deal's type, in the contract form's vocabulary (only where the two agree).
const CONTRACT_TYPES_FROM_DEAL = { '360 Deal': 'Recording', 'Master License': 'Licensing', 'Single License': 'Licensing', 'Distribution': 'Distribution', 'Publishing': 'Publishing' }
const BLANK_CONTRACT = { artist_id: '', type: '', status: 'Active', date_signed: '', expiration_date: '', royalty_split: '', advance: '', territory: '', notes: '', financial_terms: [] }

export default function Contracts() {
  const [contracts, setContracts] = useState([])
  const [envelopes, reloadEnvelopes] = useEnvelopes('contract')   // DocuSign: latest envelope per contract
  const [artists, setArtists] = useState([])
  const [searchTerm, setSearchTerm] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [selectedContract, setSelectedContract] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [uploadingId, setUploadingId] = useState(null)
  const [dragActive, setDragActive] = useState(false)
  const [missing, setMissing] = useState(null)
  const [missingOpen, setMissingOpen] = useState(true)
  const [expiring, setExpiring] = useState([])
  const [expiringOpen, setExpiringOpen] = useState(true)
  const [dropUploadContract, setDropUploadContract] = useState('')
  const [dropFile, setDropFile] = useState(null)
  const [dropUploading, setDropUploading] = useState(false)
  // Inline PDF preview from the contracts list. Single-file contracts use
  // FilePreview's `url` prop directly; multi-file contracts switch to its
  // `files` prop (built-in next/prev pager) so revisions can be flipped
  // through without leaving the list view.
  const [previewFile, setPreviewFile] = useState(null) // { url, filename } | { files: [{url, filename}, ...] }
  const [previewLoading, setPreviewLoading] = useState(false)
  // Track which contract is mid-delete so the button stays disabled while
  // the request is in flight (single source of truth — no per-row state).
  const [deletingId, setDeletingId] = useState(null)
  // Linked-data roll-up for the currently-selected contract: releases,
  // recoupment progress, expenses-by-category, income. Refetched whenever
  // selectedContract changes; the panel renders skeletons while loading.
  const [linkedData, setLinkedData] = useState(null)
  const [linkedLoading, setLinkedLoading] = useState(false)

  useEffect(() => {
    if (!selectedContract?.id) { setLinkedData(null); return }
    let cancelled = false
    setLinkedLoading(true)
    setLinkedData(null)
    api.get(`/contracts/${selectedContract.id}/linked`)
      .then(r => { if (!cancelled) setLinkedData(r.data?.data || null) })
      .catch(err => console.error('Load contract linked data:', err))
      .finally(() => { if (!cancelled) setLinkedLoading(false) })
    return () => { cancelled = true }
  }, [selectedContract?.id])

  const handleDeleteContract = async (contract, e) => {
    e.stopPropagation()
    if (deletingId === contract.id) return
    const name = contract.artist_name || `#${contract.id}`
    const type = contract.type || 'contract'
    const fileNote = (contract.file_count || 0) > 0
      ? `\n\nThis will also delete ${contract.file_count} attached file${contract.file_count === 1 ? '' : 's'}.`
      : ''
    if (!window.confirm(`Delete the ${type} contract for ${name}?${fileNote}\n\nThis cannot be undone.`)) return
    setDeletingId(contract.id)
    try {
      await api.delete(`/contracts/${contract.id}`)
      setContracts(prev => prev.filter(c => c.id !== contract.id))
      // Refresh the missing-files banner — it's keyed off the contracts
      // list and a removed contract shouldn't keep showing up there.
      fetchMissing?.()
    } catch (err) {
      console.error('Delete contract failed:', err)
      alert('Failed to delete contract: ' + (err.response?.data?.error || err.message))
    } finally {
      setDeletingId(null)
    }
  }
  const [showNewContract, setShowNewContract] = useState(false)
  // Arriving from a signed deal: /contracts?new=1&artist=Name opens the form
  // with the artist picked. If the deal named someone not on the roster, the
  // form offers to add them — a deal is the moment an artist becomes ours.
  const [searchParams, setSearchParams] = useSearchParams()
  const [wantedArtist, setWantedArtist] = useState(() => searchParams.get('artist') || '')
  const [addingArtist, setAddingArtist] = useState(false)
  const [nextStep, showNextStep, clearNextStep] = useNextStep()
  // ?deal=ID: the terms typed on the deal at Offer become the contract's
  // fields, so nothing is retyped at signing. Dates: signed today, expiring
  // term_months later when a term was given. Filled only where the form is
  // still blank — a value the person already typed wins.
  const [dealId] = useState(() => searchParams.get('deal') || '')
  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setShowNewContract(true)
      setSearchParams({}, { replace: true })
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!dealId) return
    let alive = true
    api.get(`/deals/${dealId}`).then((r) => {
      const d = r.data?.data; if (!alive || !d) return
      const today = new Date(); const iso = (x) => x.toISOString().slice(0, 10)
      const signed = iso(today)
      let expires = ''
      if (Number(d.term_months) > 0) { const e = new Date(today); e.setMonth(e.getMonth() + Number(d.term_months)); expires = iso(e) }
      setNewContractForm((f) => ({
        ...f,
        type: f.type || (d.deal_type && CONTRACT_TYPES_FROM_DEAL[d.deal_type]) || f.type,
        royalty_split: f.royalty_split || (d.royalty_split != null ? String(d.royalty_split) : ''),
        advance: f.advance || (d.advance != null && Number(d.advance) > 0 ? String(d.advance) : ''),
        territory: f.territory || d.territory || '',
        date_signed: f.date_signed || signed,
        expiration_date: f.expiration_date || expires,
        notes: f.notes || [d.num_releases ? `${d.num_releases} release${Number(d.num_releases) === 1 ? '' : 's'} committed` : null, d.option_periods ? `${d.option_periods} option period${Number(d.option_periods) === 1 ? '' : 's'}` : null, `From deal #${d.id}`].filter(Boolean).join(' · '),
      }))
    }).catch(() => {})
    return () => { alive = false }
  }, [dealId])
  useEffect(() => {
    if (!wantedArtist || !artists.length) return
    const match = artists.find(a => a.name.toLowerCase().trim() === wantedArtist.toLowerCase().trim())
    if (match) {
      setNewContractForm(f => f.artist_id ? f : { ...f, artist_id: String(match.id) })
      setWantedArtist('')
    }
  }, [wantedArtist, artists]) // eslint-disable-line react-hooks/exhaustive-deps
  const addWantedArtist = async () => {
    setAddingArtist(true)
    try {
      const r = await api.post('/artists', { name: wantedArtist.trim() })
      const a = r.data?.data
      if (a) {
        setArtists(prev => [...prev, a])
        setNewContractForm(f => ({ ...f, artist_id: String(a.id) }))
      }
      setWantedArtist('')
    } catch (err) {
      alert('Could not add the artist: ' + (err.response?.data?.error || err.message))
    } finally { setAddingArtist(false) }
  }
  // Inline edit state for an existing contract's financial_terms ("deals")
  const [editingTerms, setEditingTerms] = useState(false)
  const [termsDraft, setTermsDraft] = useState([])
  const [savingTerms, setSavingTerms] = useState(false)

  const beginEditTerms = () => {
    setTermsDraft(Array.isArray(selectedContract?.financial_terms)
      ? selectedContract.financial_terms.map(t => ({ ...t }))
      : [])
    setEditingTerms(true)
  }
  const cancelEditTerms = () => { setEditingTerms(false); setTermsDraft([]) }
  const addDraftTerm = () =>
    setTermsDraft(d => [...d, { label: '', amount: '', recoupable: false, note: '' }])
  const updateDraftTerm = (idx, patch) =>
    setTermsDraft(d => d.map((t, i) => i === idx ? { ...t, ...patch } : t))
  const removeDraftTerm = (idx) =>
    setTermsDraft(d => d.filter((_, i) => i !== idx))
  const saveTerms = async () => {
    if (!selectedContract) return
    setSavingTerms(true)
    try {
      const cleaned = termsDraft
        .map(t => ({
          label: (t.label || '').trim(),
          amount: t.amount,
          recoupable: !!t.recoupable,
          note: (t.note || '').trim() || null,
        }))
        .filter(t => t.label || t.amount)
      const res = await api.put(`/contracts/${selectedContract.id}`, { financial_terms: cleaned })
      const fresh = res.data?.data
      if (fresh) {
        const merged = { ...selectedContract, financial_terms: cleaned }
        setSelectedContract(merged)
        setContracts(prev => prev.map(c => c.id === selectedContract.id ? { ...c, financial_terms: cleaned } : c))
      }
      setEditingTerms(false)
    } catch (err) {
      setError('Failed to save deals: ' + (err.response?.data?.error || err.message))
    } finally {
      setSavingTerms(false)
    }
  }

  useHotkeys([
    { key: 'n', handler: () => setShowNewContract(true) },
  ])
  const [newContractForm, setNewContractForm] = useState(BLANK_CONTRACT)
  const [savingContract, setSavingContract] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [scanApplied, setScanApplied] = useState(false)
  const [scanDetected, setScanDetected] = useState({})
  const [scanError, setScanError] = useState('')
  const [scanDragActive, setScanDragActive] = useState(false)
  // Hold onto the File that was scanned so saveNewContract() can attach
  // it to the new contract row via POST /:id/files. The /contracts/scan
  // endpoint parses the PDF but doesn't persist it — without this, every
  // create-via-scan flow used to drop the file on the floor.
  const [scannedFile, setScannedFile] = useState(null)
  // Per-field confidence from the AI scan ("high" | "medium" | "low").
  // Drives the ⚠ chip next to AI-extracted fields in the new-contract
  // form. Cleared on the field's onChange so user edits implicitly
  // "verify" the value (chip vanishes once they touch it).
  const [scanConfidence, setScanConfidence] = useState({})
  const clearScanConfidence = (field) =>
    setScanConfidence(prev => {
      if (!prev[field]) return prev
      const next = { ...prev }
      delete next[field]
      return next
    })
  const dropFileInputRef = useRef(null)
  const scanInputRef = useRef(null)

  const contractTypes = ['Recording', 'Publishing', 'Distribution', 'Management', 'Licensing']
  const contractStatuses = ['Active', 'Pending', 'Expired', 'Terminated']

  // Reset deal-edit state whenever the selected contract changes
  useEffect(() => {
    setEditingTerms(false)
    setTermsDraft([])
  }, [selectedContract?.id])

  useEffect(() => {
    fetchContracts()
    fetchMissing()
    fetchExpiring()
    fetchArtists()
  }, [typeFilter, statusFilter])

  const fetchArtists = async () => {
    try {
      // limit=500 to surface the entire roster in the New Contract artist
      // picker. The default of 50 was truncating most of the alphabet.
      const res = await api.get('/artists?limit=500')
      setArtists(res.data.data || [])
    } catch (err) {
      console.error('Failed to load artists', err)
    }
  }

  const resetScanState = () => {
    setScanApplied(false)
    setScanDetected({})
    setScanError('')
    setScannedFile(null)
    setScanConfidence({})
  }

  const handleScanFile = async (file) => {
    if (file.type !== 'application/pdf') {
      setScanError('Only PDF files can be scanned')
      return
    }
    setScanning(true)
    setScanError('')
    setScanApplied(false)
    // Stash the File so saveNewContract can persist it after the row is
    // created. A subsequent re-scan overwrites this — the user only ever
    // ends up with one PDF queued for upload.
    setScannedFile(file)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const res = await api.post('/contracts/scan', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      const d = res.data.data

      // Try to fuzzy-match artist name against known artists
      let artist_id = newContractForm.artist_id
      let artistMatchName = null
      let artistMatchFailed = false
      if (d.artist_name) {
        const needle = d.artist_name.toLowerCase().trim()
        const match = artists.find(
          a => a.name.toLowerCase() === needle ||
               a.name.toLowerCase().includes(needle) ||
               needle.includes(a.name.toLowerCase())
        )
        if (match) {
          artist_id = String(match.id)
          artistMatchName = match.name
        } else {
          artistMatchFailed = true
        }
      }

      setNewContractForm(f => ({
        ...f,
        ...(artist_id && { artist_id }),
        ...(d.contract_type && { type: d.contract_type }),
        ...(d.royalty_split != null && { royalty_split: String(d.royalty_split) }),
        ...(d.advance != null && { advance: String(d.advance) }),
        ...(d.date_signed && { date_signed: d.date_signed }),
        ...(d.expiration_date && { expiration_date: d.expiration_date }),
        ...(d.territory && { territory: d.territory }),
        ...(d.notes && { notes: d.notes }),
        financial_terms: Array.isArray(d.financial_obligations) ? d.financial_obligations : [],
      }))
      setScanDetected({ ...d, _artistMatchName: artistMatchName, _artistMatchFailed: artistMatchFailed })
      // Pull the per-field confidence map out of the scan response. The
      // form field names ("artist_id" on the picker, "type" on the type
      // selector, etc.) don't match the AI's field names 1:1, so map them
      // here. Only fields the AI actually returned get a confidence entry.
      const conf = d._confidence || {}
      const next = {}
      if (artist_id && conf.artist_name) next.artist_id = conf.artist_name
      if (d.contract_type && conf.contract_type) next.type = conf.contract_type
      if (d.royalty_split != null && conf.royalty_split) next.royalty_split = conf.royalty_split
      if (d.advance != null && conf.advance) next.advance = conf.advance
      if (d.date_signed && conf.date_signed) next.date_signed = conf.date_signed
      if (d.expiration_date && conf.expiration_date) next.expiration_date = conf.expiration_date
      if (d.territory && conf.territory) next.territory = conf.territory
      setScanConfidence(next)
      setScanApplied(true)
      if (artistMatchFailed) {
        setScanError(`Couldn't auto-match artist "${d.artist_name}" — please select manually below.`)
      }
    } catch (err) {
      const msg = err.response?.data?.error || 'Scan failed'
      const isSetup = err.response?.data?.setup_required
      setScanError(
        isSetup
          ? 'Scanning requires ANTHROPIC_API_KEY in your Railway environment variables.'
          : msg
      )
    } finally {
      setScanning(false)
    }
  }

  const saveNewContract = async () => {
    if (!newContractForm.artist_id || !newContractForm.type) return
    setSavingContract(true)
    const savedArtistName = artists.find(a => String(a.id) === String(newContractForm.artist_id))?.name
    try {
      // Create the contract row first. If file upload fails after this
      // succeeds we surface a clear error rather than rolling back — the
      // user entered the data and wouldn't want to redo it.
      const createRes = await api.post('/contracts', {
        artist_id: parseInt(newContractForm.artist_id),
        type: newContractForm.type,
        status: newContractForm.status,
        date_signed: newContractForm.date_signed || null,
        expiration_date: newContractForm.expiration_date || null,
        royalty_split: newContractForm.royalty_split ? parseFloat(newContractForm.royalty_split) : null,
        advance: newContractForm.advance ? parseFloat(newContractForm.advance) : null,
        territory: newContractForm.territory || null,
        notes: newContractForm.notes || null,
        financial_terms: newContractForm.financial_terms || [],
      })
      const newId = createRes.data?.data?.id

      // If a PDF was scanned for terms, persist it on the new contract.
      // The /contracts/scan endpoint only parses — without this follow-up
      // POST the bytes would be lost. Surface upload failure separately
      // so the user knows the contract was saved but the file wasn't.
      let uploadFailed = null
      if (newId && scannedFile) {
        try {
          const fd = new FormData()
          fd.append('file', scannedFile)
          await api.post(`/contracts/${newId}/files`, fd, {
            headers: { 'Content-Type': 'multipart/form-data' },
          })
        } catch (err) {
          console.error('Attach scanned PDF failed:', err)
          uploadFailed = err.response?.data?.error || err.message
        }
      }

      setNewContractForm(BLANK_CONTRACT)
      setShowNewContract(false)
      if (savedArtistName) {
        showNextStep({
          title: `Contract saved for ${savedArtistName}`,
          body: 'Next is their first release. The form opens with the artist filled in.',
          to: `/releases?add=1&artist=${encodeURIComponent(savedArtistName)}`,
          label: 'Add a release',
        })
      }
      resetScanState()
      await fetchContracts()
      await fetchMissing()
      if (uploadFailed) {
        alert(
          `Contract created, but attaching the scanned PDF failed: ${uploadFailed}\n\n` +
          `Re-attach the file from the contract's Documents panel.`
        )
      }
    } catch (err) {
      alert('Failed to create contract')
    } finally {
      setSavingContract(false)
    }
  }

  const fetchContracts = async () => {
    try {
      setLoading(true)
      const params = {}
      if (typeFilter) params.type = typeFilter
      if (statusFilter) params.status = statusFilter
      const response = await api.get('/contracts', { params })
      setContracts(response.data.data || [])
    } catch (err) {
      setError('Failed to load contracts')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  const fetchMissing = async () => {
    try {
      const response = await api.get('/contracts/missing')
      setMissing(response.data.data)
    } catch (err) {
      console.error('Failed to load missing contracts:', err)
    }
  }

  const fetchExpiring = async () => {
    try {
      const response = await api.get('/contracts/expiring')
      setExpiring(response.data.data || [])
    } catch (err) {
      console.error('Failed to load expiring contracts:', err)
    }
  }

  const getExpiryBucket = (days) => {
    if (days <= 30) return { label: '≤30 days', cls: 'text-red-600 bg-red-50 border-red-200' }
    if (days <= 60) return { label: '31–60 days', cls: 'text-orange-600 bg-orange-50 border-orange-200' }
    return { label: '61–90 days', cls: 'text-amber-600 bg-amber-50 border-amber-200' }
  }

  const handleSearch = (e) => {
    setSearchTerm(e.target.value)
  }

  const filteredContracts = contracts.filter(contract => {
    const matchesSearch = !searchTerm ||
      contract.artist_name?.toLowerCase().includes(searchTerm.toLowerCase())
    return matchesSearch
  })

  // Drag and drop handlers
  const handleDrag = (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true)
    } else if (e.type === 'dragleave') {
      setDragActive(false)
    }
  }

  const handleDrop = (e, contractId) => {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)
    const file = e.dataTransfer?.files?.[0]
    if (file) processFileUpload(file, contractId)
  }

  const handleFileSelect = (e, contractId) => {
    const file = e.target.files?.[0]
    if (file) processFileUpload(file, contractId)
  }

  const processFileUpload = async (file, contractId) => {
    if (file.type !== 'application/pdf') {
      alert('Only PDF files are allowed')
      return
    }
    const isDropZone = !selectedContract
    if (isDropZone) setDropUploading(true)
    else setUploadingId(contractId)
    try {
      const formData = new FormData()
      formData.append('file', file)
      await api.post(`/contracts/${contractId}/upload`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      })
      if (selectedContract) {
        const response = await api.get(`/contracts/${contractId}`)
        setSelectedContract(response.data.data)
      }
      // Reset drop zone state
      setDropFile(null)
      setDropUploadContract('')
      fetchContracts()
      fetchMissing()
    } catch (err) {
      console.error('Failed to upload file:', err)
      alert('Failed to upload file')
    } finally {
      setUploadingId(null)
      setDropUploading(false)
    }
  }

  const getStatusBadge = (status) => {
    if (status === 'Active') return 'badge badge-green'
    if (status === 'Expired') return 'badge badge-red'
    if (status === 'Terminated') return 'badge badge-red'
    return 'badge badge-yellow'
  }

  const totalMissingCount = missing
    ? (missing.noContract?.length || 0) + (missing.noFile?.length || 0) + (missing.expiredUnreplaced?.length || 0)
    : 0

  if (loading && contracts.length === 0) {
    return (
      <div className="space-y-6">
        <Skeleton.PageHeader />
        <Skeleton.Table rows={6} cols={6} />
      </div>
    )
  }

  if (selectedContract) {
    return (
      <div className="space-y-6">
        <button
          onClick={() => setSelectedContract(null)}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors"
        >
          <ArrowLeft size={16} />
          Back to Contracts
        </button>

        <div>
          <h1 className="text-2xl font-semibold text-gray-900">{selectedContract.artist_name}</h1>
          <p className="text-sm text-gray-500 mt-1">{selectedContract.type} Agreement</p>
        </div>

        {/* Contract Details */}
        <div className="card p-5">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-y-5 gap-x-6">
            <div>
              <p className="text-xs font-medium text-gray-500 mb-1">Type</p>
              <p className="text-sm font-semibold text-gray-900">{selectedContract.type}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-gray-500 mb-1">Status</p>
              <span className={getStatusBadge(selectedContract.status)}>{selectedContract.status}</span>
            </div>
            <div>
              <p className="text-xs font-medium text-gray-500 mb-1">Territory</p>
              <p className="text-sm font-semibold text-gray-900">{selectedContract.territory || '—'}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-gray-500 mb-1">Releases</p>
              <p className="text-sm font-semibold text-gray-900">{selectedContract.num_releases || '—'}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-gray-500 mb-1">Date Signed</p>
              <p className="text-sm font-semibold text-gray-900">{formatDate(selectedContract.date_signed)}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-gray-500 mb-1">Expiration Date</p>
              <p className="text-sm font-semibold text-gray-900">{formatDate(selectedContract.expiration_date)}</p>
            </div>
            <div className="col-span-2">
              <p className="text-xs font-medium text-gray-500 mb-2">Royalty Split</p>
              {selectedContract.royalty_split != null ? (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg border border-rule bg-gray-50 px-3 py-2.5">
                      <p className="text-xs text-gray-500 mb-1">Artist</p>
                      <div className="flex items-baseline gap-1">
                        <span className="text-xl font-bold text-gray-900">{selectedContract.royalty_split}</span>
                        <span className="text-sm font-semibold text-gray-400">%</span>
                      </div>
                    </div>
                    <div className="rounded-lg border border-boom-100 bg-boom-50/40 px-3 py-2.5">
                      <p className="text-xs text-boom-500 mb-1">Market Street</p>
                      <div className="flex items-baseline gap-1">
                        <span className="text-xl font-bold text-boom-600">{100 - selectedContract.royalty_split}</span>
                        <span className="text-sm font-semibold text-boom-400">%</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex rounded-full overflow-hidden h-1.5">
                    <div className="bg-gray-400" style={{ width: `${selectedContract.royalty_split}%` }} />
                    <div className="bg-boom-400" style={{ width: `${100 - selectedContract.royalty_split}%` }} />
                  </div>
                </div>
              ) : (
                <p className="text-sm text-gray-400">—</p>
              )}
            </div>
            <div>
              <p className="text-xs font-medium text-gray-500 mb-1">Advance</p>
              <p className="text-sm font-semibold text-gray-900">{selectedContract.advance ? `$${Number(selectedContract.advance).toLocaleString()}` : '—'}</p>
            </div>
          </div>

          {selectedContract.notes && (
            <div className="mt-5 pt-5 border-t border-divider">
              <p className="text-xs font-medium text-gray-500 mb-1.5">Notes</p>
              <p className="text-sm text-gray-700">{selectedContract.notes}</p>
            </div>
          )}
        </div>

        {/* Linked data — everything the rest of the dashboard knows about
            this artist that's relevant to this contract. Joined on artist
            (releases / income / artist_budgets via artist_id; ledger
            expenses via case-insensitive name match). */}
        <LinkedDataPanel
          loading={linkedLoading}
          linked={linkedData}
          contract={selectedContract}
        />

        {/* Financial Obligations (deals) — inline editable */}
        <div className="card p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-gray-900">Financial Obligations</h2>
            {!editingTerms ? (
              <button
                onClick={beginEditTerms}
                className="text-xs text-boom-600 hover:text-boom-700 font-medium"
              >Edit</button>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  onClick={cancelEditTerms}
                  disabled={savingTerms}
                  className="text-xs text-gray-500 hover:text-gray-700 font-medium"
                >Cancel</button>
                <button
                  onClick={saveTerms}
                  disabled={savingTerms}
                  className="text-xs px-3 py-1.5 bg-gray-900 text-white rounded-lg font-semibold hover:bg-gray-700 disabled:opacity-50"
                >{savingTerms ? 'Saving…' : 'Save'}</button>
              </div>
            )}
          </div>

          {!editingTerms ? (
            Array.isArray(selectedContract.financial_terms) && selectedContract.financial_terms.length > 0 ? (
              <div className="divide-y divide-gray-100">
                {selectedContract.financial_terms.map((item, idx) => (
                  <div key={idx} className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
                    <div className="flex items-center gap-3">
                      <div className="w-1.5 h-1.5 rounded-full bg-boom-400 flex-shrink-0" />
                      <div>
                        <p className="text-sm font-medium text-gray-900">{item.label}</p>
                        {item.note && <p className="text-xs text-gray-400">{item.note}</p>}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      {item.recoupable && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-600 border border-amber-100 font-medium">
                          recoupable
                        </span>
                      )}
                      <p className="text-sm font-semibold text-gray-900 tabular-nums">
                        {item.amount != null && item.amount !== ''
                          ? (typeof item.amount === 'number'
                              ? `$${Number(item.amount).toLocaleString()}`
                              : String(item.amount).includes('%') || String(item.amount).match(/^\d/)
                                ? (String(item.amount).includes('%') ? item.amount : `$${Number(String(item.amount).replace(/,/g,'')).toLocaleString()}`)
                                : item.amount)
                          : '—'}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-gray-400 py-2">No deals on this contract yet. Click Edit to add one.</p>
            )
          ) : (
            <div className="space-y-2">
              {termsDraft.length === 0 && (
                <p className="text-xs text-gray-400 py-1">No deals yet — click "Add item" to add the first one.</p>
              )}
              {termsDraft.map((item, idx) => (
                <div key={idx} className="grid grid-cols-[1fr_1fr_auto_auto] gap-2 items-center">
                  <input
                    type="text"
                    placeholder="e.g. Recording Fund"
                    value={item.label || ''}
                    onChange={e => updateDraftTerm(idx, { label: e.target.value })}
                    className="input-base text-sm"
                  />
                  <input
                    type="text"
                    placeholder="e.g. 50000 or 15%"
                    value={item.amount ?? ''}
                    onChange={e => updateDraftTerm(idx, { amount: e.target.value })}
                    className="input-base text-sm"
                  />
                  <label className="flex items-center gap-1.5 text-xs text-gray-500 whitespace-nowrap cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={!!item.recoupable}
                      onChange={e => updateDraftTerm(idx, { recoupable: e.target.checked })}
                      className="rounded border-gray-300 text-boom-600 focus:ring-boom-500"
                    />
                    Recoupable
                  </label>
                  <button
                    type="button"
                    onClick={() => removeDraftTerm(idx)}
                    className="text-gray-300 hover:text-red-400 transition-colors"
                    aria-label="Remove deal"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={addDraftTerm}
                className="mt-2 text-xs text-boom-600 hover:text-boom-700 font-medium flex items-center gap-1"
              >
                <Plus size={12} /> Add item
              </button>
            </div>
          )}
        </div>

        {/* Documents */}
        <div className="card overflow-hidden">
          <div className="px-5 pt-4 pb-1">
            <h2 className="text-sm font-semibold text-gray-900">Documents</h2>
          </div>
          <FilesPanel
            entityType="contract"
            entityId={selectedContract.id}
            basePath="/contracts"
          />
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        tour="contracts-header"
        title="Contracts"
        subtitle="Manage your artist contracts"
        actions={
          <button data-tour="contracts-new"
            onClick={() => setShowNewContract(v => !v)}
            className="inline-flex items-center gap-2 px-4 py-2 bg-gray-900 text-white text-sm font-semibold rounded-lg hover:bg-gray-700 transition-colors"
          >
            <Plus size={15} /> New Contract
          </button>
        }
      />

      {/* New Contract Form */}
      <NextStepPrompt prompt={nextStep} onClose={clearNextStep} />
      {showNewContract && (
        <div className="card p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-900">New Contract</h2>
            <button onClick={() => { setShowNewContract(false); resetScanState() }} className="text-gray-400 hover:text-gray-600"><X size={15} /></button>
          </div>

          {/* ── Scan zone ── */}
          {scanApplied ? (
            <div className="flex items-start gap-3 px-4 py-3 bg-green-50 border border-green-200 rounded-xl">
              <CheckCircle2 size={15} className="text-green-600 mt-0.5 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-green-800 mb-0.5">
                  Contract scanned — fields auto-filled
                  {scannedFile && <span className="font-normal text-green-700"> · PDF will be saved on Create</span>}
                  {(() => {
                    // Count fields the AI flagged for human review. Same
                    // medium/low cutoff the inline ConfChips use.
                    const flagged = Object.values(scanConfidence).filter(c => c === 'medium' || c === 'low').length
                    const flaggedTerms = (newContractForm.financial_terms || [])
                      .filter(t => t?._confidence === 'medium' || t?._confidence === 'low').length
                    const total = flagged + flaggedTerms
                    if (!total) return null
                    return (
                      <span className="ml-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide text-amber-700 bg-amber-50 ring-1 ring-amber-200/60">
                        <AlertTriangle size={9} /> {total} field{total === 1 ? '' : 's'} to review
                      </span>
                    )
                  })()}
                </p>
                {scanDetected._artistMatchFailed && (
                  <p className="text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mb-1.5">
                    ⚠ Couldn't match "{scanDetected.artist_name}" to an artist — select manually below
                  </p>
                )}
                {scanDetected._artistMatchName && (
                  <p className="text-xs text-green-700 mb-1">
                    Matched artist: <span className="font-semibold">{scanDetected._artistMatchName}</span>
                  </p>
                )}
                <p className="text-xs text-green-600 leading-relaxed mb-1">
                  {[
                    scanDetected.contract_type && `Type: ${scanDetected.contract_type}`,
                    scanDetected.royalty_split != null && `Royalty: ${scanDetected.royalty_split}% / ${100 - scanDetected.royalty_split}%`,
                    scanDetected.advance != null && `Advance: $${Number(scanDetected.advance).toLocaleString()}`,
                    scanDetected.territory && `Territory: ${scanDetected.territory}`,
                  ].filter(Boolean).join('  ·  ')}
                </p>
                {Array.isArray(scanDetected.financial_obligations) && scanDetected.financial_obligations.length > 0 && (
                  <p className="text-xs text-green-600">
                    <span className="font-medium">Financial terms: </span>
                    {scanDetected.financial_obligations.map((o, i) => (
                      <span key={i}>
                        {o.label}{o.amount != null ? ` — ${typeof o.amount === 'number' ? '$' + Number(o.amount).toLocaleString() : o.amount}` : ''}
                        {o.recoupable ? ' (recoupable)' : ''}
                        {i < scanDetected.financial_obligations.length - 1 ? '  ·  ' : ''}
                      </span>
                    ))}
                  </p>
                )}
              </div>
              <button
                onClick={resetScanState}
                title="Clear scan and re-scan"
                className="text-green-400 hover:text-green-700 flex-shrink-0"
              >
                <X size={13} />
              </button>
            </div>
          ) : (
            <div>
              <div
                onClick={() => !scanning && scanInputRef.current?.click()}
                onDragEnter={e => { e.preventDefault(); e.stopPropagation(); setScanDragActive(true) }}
                onDragLeave={e => { e.preventDefault(); e.stopPropagation(); setScanDragActive(false) }}
                onDragOver={e => { e.preventDefault(); e.stopPropagation() }}
                onDrop={e => {
                  e.preventDefault(); e.stopPropagation(); setScanDragActive(false)
                  const file = e.dataTransfer?.files?.[0]
                  if (file) handleScanFile(file)
                }}
                className={`
                  flex items-center gap-3 px-4 py-3 rounded-xl border-2 border-dashed transition-all
                  ${scanning
                    ? 'border-boom-300 bg-boom-50/40 cursor-not-allowed'
                    : scanDragActive
                      ? 'border-boom-400 bg-boom-50/60 cursor-copy scale-[1.005]'
                      : 'border-rule hover:border-boom-400 hover:bg-boom-50/30 cursor-pointer'
                  }
                `}
              >
                {scanning ? (
                  <>
                    <div className="w-4 h-4 border-2 border-boom-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                    <p className="text-sm text-gray-600">Reading contract…</p>
                  </>
                ) : (
                  <>
                    <div className="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center flex-shrink-0">
                      <Sparkles size={15} className={scanDragActive ? 'text-boom-500' : 'text-gray-400'} />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-700">
                        {scanDragActive ? 'Drop to scan' : 'Scan contract PDF to auto-fill'}
                      </p>
                      <p className="text-xs text-gray-400">Drop a PDF here or click to browse · fields fill automatically</p>
                    </div>
                  </>
                )}
                <input
                  ref={scanInputRef}
                  type="file"
                  accept=".pdf"
                  className="hidden"
                  onChange={e => {
                    const f = e.target.files?.[0]
                    if (f) handleScanFile(f)
                    e.target.value = ''
                  }}
                />
              </div>
              {scanError && (
                <p className="mt-2 text-xs text-red-600 flex items-center gap-1.5">
                  <AlertTriangle size={12} /> {scanError}
                </p>
              )}
              <p className="mt-2 text-xs text-gray-400">Or fill in manually below ↓</p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="flex items-center text-xs font-medium text-gray-500 mb-1">
                Artist *<ConfChip level={scanConfidence.artist_id} />
              </label>
              <SearchableSelect
                value={artists.find(a => String(a.id) === String(newContractForm.artist_id))?.name || ''}
                onChange={name => {
                  const match = artists.find(a => a.name === name)
                  setNewContractForm(f => ({ ...f, artist_id: match ? String(match.id) : '' }))
                  clearScanConfidence('artist_id')
                }}
                options={artists.map(a => a.name)}
                placeholder="Type to search artists…"
                style={{ width: '100%', padding: '8px 12px', fontSize: 14, border: '1px solid rgb(var(--color-gray-200))', borderRadius: 8, background: 'var(--color-bg-card)', color: 'var(--color-text)', fontFamily: 'inherit', outline: 'none' }}
              />
              {wantedArtist && !newContractForm.artist_id && (
                <p className="mt-1.5 text-[11.5px] text-amber-700" data-roster-gap>
                  “{wantedArtist}” is not on the roster yet.{' '}
                  <button type="button" onClick={addWantedArtist} disabled={addingArtist} className="underline font-semibold hover:text-amber-900 disabled:opacity-50">
                    {addingArtist ? 'Adding…' : `Add ${wantedArtist} to the roster`}
                  </button>
                </p>
              )}
            </div>
            <div>
              <label className="flex items-center text-xs font-medium text-gray-500 mb-1">
                Type *<ConfChip level={scanConfidence.type} />
              </label>
              <select value={newContractForm.type} onChange={e => { setNewContractForm(f => ({ ...f, type: e.target.value })); clearScanConfidence('type') }}
                className="select-base w-full">
                <option value="">Select type…</option>
                {contractTypes.map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Status</label>
              <select value={newContractForm.status} onChange={e => setNewContractForm(f => ({ ...f, status: e.target.value }))}
                className="select-base w-full">
                {contractStatuses.map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
            <div className="col-span-2">
              <label className="flex items-center text-xs font-medium text-gray-500 mb-2">
                Royalty Split<ConfChip level={scanConfidence.royalty_split} />
              </label>
              {(() => {
                const artistPct = newContractForm.royalty_split !== '' && !isNaN(Number(newContractForm.royalty_split))
                  ? Math.min(100, Math.max(0, Number(newContractForm.royalty_split)))
                  : null
                const boomPct = artistPct != null ? 100 - artistPct : null
                return (
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      {/* Artist box */}
                      <div className="relative rounded-lg border border-rule bg-gray-50 px-3 py-2.5">
                        <p className="text-xs text-gray-500 mb-1">Artist</p>
                        <div className="flex items-baseline gap-1">
                          <input
                            type="number"
                            placeholder="—"
                            min="0"
                            max="100"
                            value={newContractForm.royalty_split}
                            onChange={e => { setNewContractForm(f => ({ ...f, royalty_split: e.target.value })); clearScanConfidence('royalty_split') }}
                            className="w-16 text-xl font-bold text-gray-900 bg-transparent border-none outline-none p-0 focus:ring-0"
                          />
                          <span className="text-sm font-semibold text-gray-400">%</span>
                        </div>
                      </div>
                      {/* Market Street box */}
                      <div className="rounded-lg border border-boom-100 bg-boom-50/40 px-3 py-2.5">
                        <p className="text-xs text-boom-500 mb-1">Market Street</p>
                        <div className="flex items-baseline gap-1">
                          <span className="text-xl font-bold text-boom-600">
                            {boomPct != null ? boomPct : '—'}
                          </span>
                          {boomPct != null && <span className="text-sm font-semibold text-boom-400">%</span>}
                        </div>
                      </div>
                    </div>
                    {/* Split bar */}
                    {artistPct != null && (
                      <div className="flex rounded-full overflow-hidden h-1.5">
                        <div className="bg-gray-400 transition-all duration-200" style={{ width: `${artistPct}%` }} />
                        <div className="bg-boom-400 transition-all duration-200" style={{ width: `${boomPct}%` }} />
                      </div>
                    )}
                  </div>
                )
              })()}
            </div>
            <div>
              <label className="flex items-center text-xs font-medium text-gray-500 mb-1">
                Date Signed<ConfChip level={scanConfidence.date_signed} />
              </label>
              <input type="date" value={newContractForm.date_signed}
                onChange={e => { setNewContractForm(f => ({ ...f, date_signed: e.target.value })); clearScanConfidence('date_signed') }}
                className="input-base w-full" />
            </div>
            <div>
              <label className="flex items-center text-xs font-medium text-gray-500 mb-1">
                Expiration Date<ConfChip level={scanConfidence.expiration_date} />
              </label>
              <input type="date" value={newContractForm.expiration_date}
                onChange={e => { setNewContractForm(f => ({ ...f, expiration_date: e.target.value })); clearScanConfidence('expiration_date') }}
                className="input-base w-full" />
            </div>
            <div>
              <label className="flex items-center text-xs font-medium text-gray-500 mb-1">
                Advance ($)<ConfChip level={scanConfidence.advance} />
              </label>
              <input type="number" placeholder="e.g. 5000" value={newContractForm.advance}
                onChange={e => { setNewContractForm(f => ({ ...f, advance: e.target.value })); clearScanConfidence('advance') }}
                className="input-base w-full" />
            </div>
            <div>
              <label className="flex items-center text-xs font-medium text-gray-500 mb-1">
                Territory<ConfChip level={scanConfidence.territory} />
              </label>
              <input type="text" placeholder="e.g. Worldwide" value={newContractForm.territory}
                onChange={e => { setNewContractForm(f => ({ ...f, territory: e.target.value })); clearScanConfidence('territory') }}
                className="input-base w-full" />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-gray-500 mb-1">Notes</label>
              <textarea rows={2} placeholder="Any additional notes…" value={newContractForm.notes}
                onChange={e => setNewContractForm(f => ({ ...f, notes: e.target.value }))}
                className="input-base w-full resize-none" />
            </div>
          </div>

          {/* Financial Obligations */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-gray-500">Financial Obligations</label>
              <button
                type="button"
                onClick={() => setNewContractForm(f => ({
                  ...f,
                  financial_terms: [...(f.financial_terms || []), { label: '', amount: '', recoupable: false, note: '' }]
                }))}
                className="text-xs text-boom-600 hover:text-boom-700 font-medium flex items-center gap-1"
              >
                <Plus size={12} /> Add item
              </button>
            </div>
            {(!newContractForm.financial_terms || newContractForm.financial_terms.length === 0) ? (
              <p className="text-xs text-gray-400 py-2">
                No financial terms yet — scan a contract PDF above or add manually.
              </p>
            ) : (
              <div className="space-y-2">
                {newContractForm.financial_terms.map((item, idx) => {
                  // Per-row AI confidence — clears the moment any field on
                  // this row is touched (the helper below `patchTerm` does
                  // the work). Renders a chip on medium/low rows so users
                  // know which extracted terms to eyeball.
                  const rowConf = item?._confidence
                  const patchTerm = (patch) => setNewContractForm(f => {
                    const terms = [...f.financial_terms]
                    // Drop _confidence on edit — user touched it, so the
                    // chip's job is done.
                    const { _confidence: _drop, ...rest } = terms[idx] || {}
                    terms[idx] = { ...rest, ...patch }
                    return { ...f, financial_terms: terms }
                  })
                  return (
                  <div key={idx}>
                    {rowConf && rowConf !== 'high' && (
                      <div className="mb-1">
                        <ConfChip level={rowConf} />
                      </div>
                    )}
                    <div className="grid grid-cols-[1fr_1fr_auto_auto] gap-2 items-center">
                    <input
                      type="text"
                      placeholder="e.g. Recording Fund"
                      value={item.label}
                      onChange={e => patchTerm({ label: e.target.value })}
                      className="input-base text-sm"
                    />
                    <input
                      type="text"
                      placeholder="e.g. 50000 or 15%"
                      value={item.amount}
                      onChange={e => patchTerm({ amount: e.target.value })}
                      className="input-base text-sm"
                    />
                    <label className="flex items-center gap-1.5 text-xs text-gray-500 whitespace-nowrap cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={item.recoupable || false}
                        onChange={e => patchTerm({ recoupable: e.target.checked })}
                        className="rounded border-gray-300 text-boom-600 focus:ring-boom-500"
                      />
                      Recoupable
                    </label>
                    <button
                      type="button"
                      onClick={() => setNewContractForm(f => ({
                        ...f,
                        financial_terms: f.financial_terms.filter((_, i) => i !== idx)
                      }))}
                      className="text-gray-300 hover:text-red-400 transition-colors"
                    >
                      <X size={14} />
                    </button>
                    </div>
                  </div>
                  )
                })}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button onClick={() => { setShowNewContract(false); resetScanState() }} className="text-sm text-gray-400 hover:text-gray-600 px-3 py-2">Cancel</button>
            <button onClick={saveNewContract} disabled={savingContract || !newContractForm.artist_id || !newContractForm.type}
              className="px-4 py-2 bg-gray-900 text-white text-sm font-semibold rounded-lg hover:bg-gray-700 disabled:opacity-40 transition-colors">
              {savingContract ? 'Saving…' : 'Create Contract'}
            </button>
          </div>
        </div>
      )}

      {/* Missing Contracts Section */}
      {totalMissingCount > 0 && (
        <div className="card overflow-hidden">
          <button
            onClick={() => setMissingOpen(!missingOpen)}
            className="w-full px-5 py-3.5 flex items-center justify-between hover:bg-surface-50 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-amber-50 flex items-center justify-center">
                <AlertTriangle size={16} className="text-amber-500" />
              </div>
              <div className="text-left">
                <p className="text-sm font-semibold text-gray-900">Missing Contracts</p>
                <p className="text-xs text-gray-500">{totalMissingCount} issue{totalMissingCount !== 1 ? 's' : ''} need attention</p>
              </div>
            </div>
            {missingOpen ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
          </button>

          {missingOpen && (
            <div className="border-t border-divider divide-y divide-gray-100">
              {/* Artists with no contract at all */}
              {missing?.noContract?.length > 0 && (
                <div className="px-5 py-4">
                  <div className="flex items-center gap-2 mb-3">
                    <UserX size={14} className="text-red-500" />
                    <p className="text-xs font-semibold text-gray-700 uppercase tracking-wider">No Contract on File</p>
                    <span className="badge badge-red ml-1">{missing.noContract.length}</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                    {missing.noContract.map(artist => (
                      <div key={artist.id} className="flex items-center justify-between px-3 py-2 bg-red-50/50 rounded-lg border border-red-100">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">{artist.name}</p>
                          <p className="text-xs text-gray-500">{artist.release_count} release{artist.release_count !== 1 ? 's' : ''}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Contracts missing file uploads */}
              {missing?.noFile?.length > 0 && (
                <div className="px-5 py-4">
                  <div className="flex items-center gap-2 mb-3">
                    <FileX size={14} className="text-amber-500" />
                    <p className="text-xs font-semibold text-gray-700 uppercase tracking-wider">Missing Document Upload</p>
                    <span className="badge badge-yellow ml-1">{missing.noFile.length}</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                    {missing.noFile.map(c => (
                      <button
                        key={c.contract_id}
                        onClick={() => {
                          const full = contracts.find(x => x.id === c.contract_id)
                          if (full) setSelectedContract(full)
                        }}
                        className="flex items-center justify-between px-3 py-2 bg-amber-50/50 rounded-lg border border-amber-100 text-left hover:border-amber-300 transition-colors"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">{c.artist_name}</p>
                          <p className="text-xs text-gray-500">{c.type} · {c.status}</p>
                        </div>
                        <Upload size={13} className="text-amber-400 flex-shrink-0 ml-2" />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Expired contracts with no active replacement */}
              {missing?.expiredUnreplaced?.length > 0 && (
                <div className="px-5 py-4">
                  <div className="flex items-center gap-2 mb-3">
                    <Clock size={14} className="text-gray-500" />
                    <p className="text-xs font-semibold text-gray-700 uppercase tracking-wider">Expired — No Active Replacement</p>
                    <span className="badge badge-gray ml-1">{missing.expiredUnreplaced.length}</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                    {missing.expiredUnreplaced.map((c, idx) => (
                      <div key={idx} className="flex items-center justify-between px-3 py-2 bg-gray-50 rounded-lg border border-rule">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">{c.name}</p>
                          <p className="text-xs text-gray-500">{c.type} · expired {formatDate(c.expiration_date)}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Expiring Contracts — within 90 days */}
      {expiring.length > 0 && (
        <div className="card overflow-hidden">
          <button
            onClick={() => setExpiringOpen(!expiringOpen)}
            className="w-full px-5 py-3.5 flex items-center justify-between hover:bg-surface-50 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-orange-50 flex items-center justify-center">
                <Bell size={16} className="text-orange-500" />
              </div>
              <div className="text-left">
                <p className="text-sm font-semibold text-gray-900">Contracts Expiring Soon</p>
                <p className="text-xs text-gray-500">{expiring.length} active contract{expiring.length !== 1 ? 's' : ''} expire within 90 days</p>
              </div>
            </div>
            {expiringOpen ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
          </button>

          {expiringOpen && (
            <div className="border-t border-divider px-5 py-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {expiring.map(c => {
                  const bucket = getExpiryBucket(c.days_until_expiry)
                  return (
                    <button
                      key={c.id}
                      onClick={() => setSelectedContract(c)}
                      className={`flex items-center justify-between px-3 py-2.5 rounded-lg border text-left hover:opacity-80 transition-opacity ${bucket.cls}`}
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{c.artist_name}</p>
                        <p className="text-xs text-gray-500">{c.type}</p>
                      </div>
                      <div className="flex-shrink-0 text-right ml-3">
                        <p className="text-xs font-bold tabular-nums">{c.days_until_expiry}d</p>
                        <p className="text-xs opacity-70">{formatDate(c.expiration_date)}</p>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Filters */}
      <div data-tour="contracts-filters" className="card p-4 flex flex-col md:flex-row gap-3">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
          <input type="text" placeholder="Search by artist name..." value={searchTerm} onChange={handleSearch} className="input-base pl-9" />
        </div>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="select-base">
          <option value="">All Types</option>
          {contractTypes.map(type => (<option key={type} value={type}>{type}</option>))}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="select-base">
          <option value="">All Statuses</option>
          {contractStatuses.map(status => (<option key={status} value={status}>{status}</option>))}
        </select>
      </div>

      {/* Quick-attach from list */}
      <div data-tour="contracts-attach" className="card p-4">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Attach Document to Contract</h2>

        <div className="flex items-center gap-3">
          {/* Step 1: pick a contract */}
          <select
            value={dropUploadContract}
            onChange={(e) => { setDropUploadContract(e.target.value); setDropFile(null) }}
            className="select-base flex-1"
          >
            <option value="">Choose a contract…</option>
            {contracts.map(c => (
              <option key={c.id} value={c.id}>
                {c.artist_name} — {c.type} ({c.status})
              </option>
            ))}
          </select>

          {/* Compact drop zone */}
          <div
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setDragActive(false)
              if (!dropUploadContract) return
              const file = e.dataTransfer?.files?.[0]
              if (file) processFileUpload(file, parseInt(dropUploadContract))
            }}
            onClick={() => { if (dropUploadContract) dropFileInputRef.current?.click() }}
            className={`
              flex items-center gap-2 px-4 py-2.5 rounded-lg border-2 border-dashed transition-all flex-shrink-0
              ${!dropUploadContract
                ? 'border-rule bg-gray-50 opacity-50 cursor-not-allowed'
                : dragActive
                  ? 'border-boom-400 bg-boom-50 cursor-pointer'
                  : 'border-gray-300 hover:border-boom-400 hover:bg-boom-50/30 cursor-pointer'
              }
              ${dropUploading ? 'pointer-events-none opacity-60' : ''}
            `}
          >
            {dropUploading
              ? <div className="w-4 h-4 border-2 border-boom-500 border-t-transparent rounded-full animate-spin" />
              : <Upload size={14} className={dragActive ? 'text-boom-500' : 'text-gray-400'} />
            }
            <span className="text-xs font-medium text-gray-600 whitespace-nowrap">
              {dropUploading ? 'Uploading…' : dragActive ? 'Drop here' : 'Drop or browse PDF'}
            </span>
            <input
              ref={dropFileInputRef}
              type="file"
              accept=".pdf"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (!file || !dropUploadContract) return
                processFileUpload(file, parseInt(dropUploadContract))
                e.target.value = ''
              }}
              className="hidden"
            />
          </div>
        </div>
      </div>

      {error && <div className="text-sm text-red-600 text-center py-12">{error}</div>}

      {/* Inline PDF preview from the list. Both single (`url` + `filename`)
          and multi (`files`) shapes route through the same component — the
          multi shape uses FilePreview's built-in paginator so revisions
          can be stepped through without leaving the list. */}
      {previewFile && (
        <FilePreview
          url={previewFile.url}
          filename={previewFile.filename}
          files={previewFile.files}
          onClose={() => setPreviewFile(null)}
        />
      )}

      {/* Contracts Table */}
      <div data-tour="contracts-table" className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-rule bg-surface-50">
                <th className="table-header">Artist</th>
                <th className="table-header">Type</th>
                <th className="table-header">Status</th>
                <th className="table-header">Signed</th>
                <th className="table-header">Expires</th>
                <th className="table-header">Artist / Market Street</th>
                <th className="table-header w-10">Doc</th>
                <th className="table-header w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filteredContracts.length === 0 ? (
                <tr>
                  <td colSpan="8" className="px-4 py-12 text-center text-sm text-gray-400">No contracts found</td>
                </tr>
              ) : (
                filteredContracts.map(contract => (
                  <tr key={contract.id} onClick={() => setSelectedContract(contract)} className="hover:bg-surface-50 cursor-pointer transition-colors">
                    <td className="table-cell font-medium text-gray-900">{contract.artist_name}</td>
                    <td className="table-cell text-gray-500">{contract.type}</td>
                    <td className="table-cell"><span className={getStatusBadge(contract.status)}>{contract.status}</span></td>
                    <td className="table-cell text-gray-500">{formatDate(contract.date_signed)}</td>
                    <td className="table-cell text-gray-500">{formatDate(contract.expiration_date)}</td>
                    <td className="table-cell">
                      {contract.royalty_split != null ? (
                        <span className="inline-flex items-center gap-1 text-sm">
                          <span className="font-medium text-gray-900">{contract.royalty_split}%</span>
                          <span className="text-gray-400">/</span>
                          <span className="font-medium text-boom-600">{100 - contract.royalty_split}%</span>
                        </span>
                      ) : '—'}
                    </td>
                    <td className="table-cell">
                      {(() => {
                        // Prefer entity_files's latest upload — covers every
                        // contract with any uploaded PDF, including ones whose
                        // legacy file_path column was never populated. Fall
                        // back to file_path for legacy rows.
                        const previewName = contract.latest_file_filename || contract.file_path
                        if (!previewName) return <FileX size={14} className="text-gray-300" />
                        const fileCount = contract.file_count || 1
                        const isLoading = previewLoading === contract.id
                        return (
                          <button
                            onClick={async (e) => {
                              e.stopPropagation()
                              if (fileCount > 1) {
                                // Multi-revision contracts: fetch the file
                                // list so FilePreview's paginated mode can
                                // step through every PDF inline. No detail-
                                // view round trip, no new tab.
                                setPreviewLoading(contract.id)
                                try {
                                  const r = await api.get(`/contracts/${contract.id}/files`)
                                  const files = (r.data?.data || []).map(f => ({
                                    url: getFileUrl(f.filename),
                                    filename: f.original_name || f.filename,
                                  }))
                                  if (files.length) {
                                    setPreviewFile({ files })
                                  } else {
                                    // entity_files came back empty but the
                                    // list said it had files — fall back to
                                    // the legacy file_path single preview.
                                    setPreviewFile({
                                      url: getFileUrl(previewName),
                                      filename: contract.latest_file_original_name || previewName,
                                    })
                                  }
                                } catch (err) {
                                  console.error('Load contract files:', err)
                                  alert('Failed to load files: ' + (err.response?.data?.error || err.message))
                                } finally {
                                  setPreviewLoading(false)
                                }
                              } else {
                                setPreviewFile({
                                  url: getFileUrl(previewName),
                                  filename: contract.latest_file_original_name || previewName,
                                })
                              }
                            }}
                            disabled={isLoading}
                            title={fileCount > 1 ? `View ${fileCount} uploaded PDFs` : 'View PDF'}
                            className="inline-flex items-center gap-1 text-boom-500 hover:text-boom-700 transition-colors disabled:opacity-60"
                          >
                            <File size={14} />
                            {fileCount > 1 && (
                              <span className="text-[10px] font-bold tabular-nums">{fileCount}</span>
                            )}
                            <Eye size={10} className="opacity-60" />
                          </button>
                        )
                      })()}
                    </td>
                    <td className="table-cell text-right" onClick={(e) => e.stopPropagation()}>
                      <SendForSignatureButton docType="contract" docId={contract.id} envelope={envelopes[contract.id]} defaults={{ name: contract.artist_name, email: contract.artist_email }} onChanged={() => { reloadEnvelopes(); fetchContracts() }} />
                      <button
                        onClick={(e) => handleDeleteContract(contract, e)}
                        disabled={deletingId === contract.id}
                        className="text-gray-300 hover:text-rose-600 transition-colors p-1 disabled:opacity-50"
                        title="Delete this contract (also removes attached files)"
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ── LinkedDataPanel ─────────────────────────────────────────────────────────
// Pulls roll-up numbers from the rest of the dashboard (releases, ledger
// expenses, artist_income) into one card on the contract detail view, so
// users don't have to bounce to four different pages to answer "how is this
// deal performing." Lifetime numbers are artist-scoped (releases don't
// carry a contract_id today); the "during term" line is bounded by the
// contract's signed→expiration window.
function LinkedDataPanel({ loading, linked, contract }) {
  if (loading) {
    return (
      <div className="card p-5">
        <div className="flex items-center gap-2 mb-4">
          <TrendingUp size={15} className="text-boom-500" />
          <h2 className="text-sm font-semibold text-gray-900">Linked data</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {[0, 1, 2].map(i => (
            <div key={i} className="h-24 bg-gray-50 rounded-lg animate-pulse" />
          ))}
        </div>
      </div>
    )
  }
  if (!linked) return null

  const usd = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(n) || 0)
  const advance = Number(contract?.advance) || 0
  const { expenses, releases, income } = linked
  // Pending = recoupable rows the label hasn't yet flagged "uploaded for
  // recoupment." Negative numbers shouldn't happen but we floor at 0
  // defensively so a data hiccup never shows "$-200 pending."
  const pendingRecoup = Math.max(0, (expenses?.recoupable_total || 0) - (expenses?.ufr_total || 0))
  // Top-line "exposure": what the artist owes back to the label if every
  // recoupable expense + the advance gets uploaded. The bar visualizes how
  // much of that has been formally uploaded (UFR).
  const totalExposure = advance + (expenses?.recoupable_total || 0)
  const recoupPct = totalExposure > 0
    ? Math.min(100, Math.round(((expenses?.ufr_total || 0) / totalExposure) * 100))
    : 0
  const incomeOffsetPct = totalExposure > 0
    ? Math.min(100, Math.round(((income?.total || 0) / totalExposure) * 100))
    : 0

  return (
    <div className="card p-5 space-y-5">
      <div className="flex items-center gap-2">
        <TrendingUp size={15} className="text-boom-500" />
        <h2 className="text-sm font-semibold text-gray-900">Linked data</h2>
        <span className="text-[10px] text-gray-400">artist-scoped · joined from the rest of the dashboard</span>
      </div>

      {/* Recoupment progress — the headline. Three columns of the recoupment
          breakdown plus a stacked progress bar (UFR vs pending recoupable). */}
      {(advance > 0 || expenses?.recoupable_total > 0) && (
        <div className="rounded-xl border border-rule p-4 bg-gray-50/50">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <PiggyBank size={13} className="text-boom-500" />
              <span className="text-xs font-bold uppercase tracking-wide text-gray-500">Recoupment</span>
            </div>
            <span className="text-[10px] text-gray-400">
              {recoupPct}% of {usd(totalExposure)} exposure uploaded
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
            <Stat label="Advance" value={usd(advance)} tone="default" />
            <Stat
              label="Uploaded for recoupment"
              value={usd(expenses?.ufr_total || 0)}
              sub={`${expenses?.ufr_count || 0} row${expenses?.ufr_count === 1 ? '' : 's'}`}
              tone="green"
            />
            <Stat
              label="Recoupable, pending"
              value={usd(pendingRecoup)}
              sub={`${Math.max(0, (expenses?.recoupable_count || 0) - (expenses?.ufr_count || 0))} row${pendingRecoup === 0 ? 's' : ''}`}
              tone={pendingRecoup > 0 ? 'amber' : 'default'}
            />
            <Stat
              label="Income (lifetime)"
              value={usd(income?.total || 0)}
              sub={(income?.during_term || 0) > 0 ? `${usd(income.during_term)} in-term` : 'no in-term income'}
              tone={(income?.total || 0) > totalExposure ? 'green' : 'default'}
            />
          </div>
          {/* Stacked progress bar: emerald = uploaded, amber = pending,
              gray = the remainder of the exposure. */}
          {totalExposure > 0 && (
            <div className="space-y-1">
              <div className="flex rounded-full overflow-hidden h-2 bg-gray-200">
                <div
                  className="bg-emerald-500"
                  style={{ width: `${recoupPct}%` }}
                  title={`Uploaded: ${usd(expenses?.ufr_total || 0)}`}
                />
                <div
                  className="bg-amber-400"
                  style={{ width: `${Math.min(100 - recoupPct, totalExposure > 0 ? (pendingRecoup / totalExposure) * 100 : 0)}%` }}
                  title={`Pending: ${usd(pendingRecoup)}`}
                />
              </div>
              {/* Secondary line: income vs exposure — "is this deal close
                  to paying for itself?" */}
              {income?.total > 0 && (
                <div className="flex items-center gap-2 text-[10px] text-gray-500">
                  <span>Income offset:</span>
                  <div className="flex-1 h-1.5 rounded-full bg-gray-200 overflow-hidden max-w-[180px]">
                    <div className="h-full bg-boom-500" style={{ width: `${incomeOffsetPct}%` }} />
                  </div>
                  <span className="tabular-nums font-semibold">{incomeOffsetPct}%</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* Releases — count lifetime + during term, plus recent five with
            project name. Each release links into the Release Tracker. */}
        <div className="rounded-xl border border-rule p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Music2 size={13} className="text-boom-500" />
              <span className="text-xs font-bold uppercase tracking-wide text-gray-500">Releases</span>
            </div>
          </div>
          <div className="flex items-baseline gap-2 mb-2">
            <span className="text-2xl font-bold text-gray-900 tabular-nums">{releases?.total || 0}</span>
            <span className="text-xs text-gray-400">lifetime</span>
          </div>
          {(releases?.during_term || 0) > 0 && (
            <p className="text-[11px] text-gray-500 mb-3">
              <span className="font-semibold tabular-nums text-gray-700">{releases.during_term}</span>{' '}
              shipped during this contract's term
            </p>
          )}
          {(releases?.recent || []).length > 0 && (
            <ul className="space-y-1.5 mt-2">
              {releases.recent.slice(0, 4).map(r => (
                <li key={r.id} className="text-[11px] text-gray-600 flex items-center gap-1.5 truncate">
                  <Link to={`/releases/${r.id}`} className="hover:text-boom-600 truncate font-medium">
                    {r.project_name || `Release #${r.id}`}
                  </Link>
                  {r.release_date && (
                    <span className="text-gray-400 flex-shrink-0">· {formatDate(r.release_date)}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {(!releases?.recent || releases.recent.length === 0) && (
            <p className="text-[11px] text-gray-400 mt-2">No releases on file.</p>
          )}
        </div>

        {/* Income — total + by type breakdown. */}
        <div className="rounded-xl border border-rule p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <DollarSign size={13} className="text-emerald-600" />
              <span className="text-xs font-bold uppercase tracking-wide text-gray-500">Income</span>
            </div>
          </div>
          <div className="flex items-baseline gap-2 mb-2">
            <span className="text-2xl font-bold text-gray-900 tabular-nums">{usd(income?.total || 0)}</span>
            <span className="text-xs text-gray-400">lifetime</span>
          </div>
          {(income?.during_term || 0) > 0 && (
            <p className="text-[11px] text-gray-500 mb-3">
              <span className="font-semibold tabular-nums text-gray-700">{usd(income.during_term)}</span>{' '}
              earned during this contract's term
            </p>
          )}
          {(income?.by_type || []).length > 0 ? (
            <ul className="space-y-1.5 mt-2">
              {income.by_type.slice(0, 4).map((t, i) => (
                <li key={i} className="text-[11px] flex items-center justify-between gap-2">
                  <span className="text-gray-600 truncate">{t.income_type}</span>
                  <span className="text-gray-700 font-semibold tabular-nums">{usd(t.total)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[11px] text-gray-400 mt-2">No income on file.</p>
          )}
        </div>

        {/* Spend by category — top 6 categories with a horizontal bar so
            "marketing's eaten the budget" jumps out. */}
        <div className="rounded-xl border border-rule p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <BarChart3 size={13} className="text-rose-500" />
              <span className="text-xs font-bold uppercase tracking-wide text-gray-500">Spend by category</span>
            </div>
          </div>
          <div className="flex items-baseline gap-2 mb-3">
            <span className="text-2xl font-bold text-gray-900 tabular-nums">{usd(expenses?.total || 0)}</span>
            <span className="text-xs text-gray-400">
              {expenses?.count || 0} row{expenses?.count === 1 ? '' : 's'}
            </span>
          </div>
          {(expenses?.by_category || []).length > 0 ? (
            (() => {
              const max = Math.max(...expenses.by_category.map(c => Number(c.total) || 0), 1)
              return (
                <ul className="space-y-2">
                  {expenses.by_category.slice(0, 5).map((c, i) => {
                    const pct = max > 0 ? (Number(c.total) / max) * 100 : 0
                    return (
                      <li key={i}>
                        <div className="flex items-center justify-between text-[11px] mb-0.5">
                          <span className="text-gray-600 truncate">{c.category}</span>
                          <span className="text-gray-700 font-semibold tabular-nums">{usd(c.total)}</span>
                        </div>
                        <div className="h-1 rounded-full bg-gray-100 overflow-hidden">
                          <div className="h-full bg-rose-400" style={{ width: `${pct}%` }} />
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )
            })()
          ) : (
            <p className="text-[11px] text-gray-400 mt-2">No expenses on file.</p>
          )}
          {(expenses?.unpaid_count || 0) > 0 && (
            <p className="text-[10px] text-rose-700 bg-rose-50 ring-1 ring-rose-200/60 rounded px-1.5 py-1 mt-3 inline-flex items-center gap-1 font-semibold">
              {expenses.unpaid_count} unpaid · {usd(expenses.unpaid_total)}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

// ── ConfChip ────────────────────────────────────────────────────────────────
// Small ⚠ pill rendered next to AI-scanned form fields. Three states:
//   high   → no chip (the AI lifted the value directly from the page)
//   medium → amber "inferred" pill (value was implied, double-check it)
//   low    → rose "guessed" pill (value was a default / not really in the
//            contract, definitely double-check)
// Editing the field clears the chip — the controlled-input onChange wires
// to clearScanConfidence() so user interaction implicitly verifies.
function ConfChip({ level }) {
  if (!level || level === 'high') return null
  if (level === 'medium') {
    return (
      <span
        className="ml-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide text-amber-700 bg-amber-50 ring-1 ring-amber-200/60"
        title="AI inferred this value from context — please double-check."
      >
        <AlertTriangle size={8} /> AI guess
      </span>
    )
  }
  return (
    <span
      className="ml-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide text-rose-700 bg-rose-50 ring-1 ring-rose-200/60"
      title="AI was uncertain about this value — verify against the PDF."
    >
      <AlertTriangle size={8} /> low confidence
    </span>
  )
}

function Stat({ label, value, sub, tone = 'default' }) {
  const tones = {
    default: 'text-gray-900',
    green:   'text-emerald-700',
    amber:   'text-amber-700',
  }
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide font-bold text-gray-500">{label}</p>
      <p className={`text-base font-bold tabular-nums mt-0.5 ${tones[tone] || tones.default}`}>{value}</p>
      {sub && <p className="text-[10px] text-gray-400 mt-0.5">{sub}</p>}
    </div>
  )
}
