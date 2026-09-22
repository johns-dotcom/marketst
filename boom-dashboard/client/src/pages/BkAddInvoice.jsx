import { useState, useRef, useEffect, useMemo } from 'react'
import { Upload, Loader, AlertCircle, CheckCircle, Plus, Trash2, AlertTriangle, ShieldCheck, Receipt, AtSign, Zap, Pause, Package } from 'lucide-react'
import api from '../api'
import PageHeader from '../components/PageHeader'
import ReviewDeck, { useDeckPreview } from '../components/ReviewDeck'
import InlineFilePreview from '../components/InlineFilePreview'
import ApprovalChecklistFields from '../components/ApprovalChecklistFields'
import SocialHandlesEditor from '../components/SocialHandlesEditor'
import { answerCobrand, checklistComplete, checklistPayload, checklistOutstanding }
  from '../lib/approvalChecklist'
import useUnsavedWarning from '../hooks/useUnsavedWarning'
import { CATEGORIES, PAYMENT_METHODS, SOCIAL_PLATFORMS } from '../constants'
import { useCategories } from '../context/CategoriesContext'
import { useAuth } from '../context/AuthContext'
import { useBoomReps } from '../context/BoomRepsContext'
import { normalizeInvoiceNum } from '../utils'

export default function BkAddInvoice() {
  // Live expense categories. Bound to the same name the module-level
  // import used, so every CATEGORIES reference in this component now
  // reads the vocabulary from context (which falls back to that same
  // constant if the fetch fails). Categories are user-created on the
  // Statements and Reports pages — a hardcoded list here would leave
  // this dropdown unable to render its own rows' values.
  const CATEGORIES = useCategories()
  const { user } = useAuth()
  // Admin-level (Admin / Superadmin / Approver — same set as the server's
  // isBkAdmin) submit with the fast path. Everyone else must supply the
  // song and at least one social handle: User-level adds are campaign
  // spend, and missing song/socials are the top reconciliation gaps on
  // the Artist Campaigns page.
  const role = (user?.role || '').toLowerCase()
  const isAdminLevel = role === 'admin' || role === 'superadmin' || role === 'approver'
  const BOOM_REPS = useBoomReps()
  // market.st rep dropdown options — make sure the current user shows up even if
  // they aren't in the canonical BOOM_REPS list, so non-admins can save with
  // their own name as the rep on the entry that lands in approvals.
  const repOptions = user?.name && !BOOM_REPS.includes(user.name)
    ? [...BOOM_REPS, user.name]
    : BOOM_REPS
  const fileInputRef = useRef(null)
  const [dragActive, setDragActive] = useState(false)
  const [file, setFile] = useState(null)
  const [parsing, setParsing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  // The approval review, opened by Save. `reviewChecks` holds the answers; it is
  // cleared every time the review opens so a previous invoice's answers can
  // never be inherited by the next one — that would be the tick meaning
  // "nobody looked" again, which is the whole thing this closes.
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewChecks, setReviewChecks] = useState({})
  const [previewOn, togglePreview] = useDeckPreview()

  const [w9File, setW9File] = useState(null)
  const [proofFile, setProofFile] = useState(null)
  // Receipt file — only used when is_reimbursement is on. Matches the
  // vendor-submit form's receipt upload path.
  const [receiptFile, setReceiptFile] = useState(null)

  const [form, setForm] = useState({
    invoice_date: '',
    payee: '',
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
    cobrand: false,
    is_reimbursement: false,
    // Bulk deal — a deal bought in units (posts, videos, edits) rather than one
    // deliverable. Answered HERE because the person typing the invoice knows;
    // until now the first chance to say so was the approval checklist, which
    // meant the approver had to work it out from the description.
    is_bulk_deal: false,
    bulk_deal_quantity: '',
    bulk_deal_unit: '',
    vendor_email: '',
    // Vendor Submit collects mailing address + bank name for payment
    // routing. Mirror those fields here so an admin entering an invoice
    // captures the same info a vendor would submit through the portal.
    vendor_address: '',
    vendor_bank: '',
    payment_status: 'Unpaid',
    payment_date: '',
    payment_ref: '',
    // Urgency token applied at create time. One of 'none' | 'rush' | 'hold'.
    // Mutex enforced by the tri-state selector; server also refuses if both
    // rush_requested + on_hold arrive true in the same payload. Gated on
    // payment_status !== 'Paid' — the DB trigger clears them on Paid anyway.
    urgency: 'none',
    urgency_reason: '',
  })
  // Social handles editor — same shape as vendor-submit's socialRows.
  // Sent to the server as JSON on `social_handles` (JSONB column).
  const [socialRows, setSocialRows] = useState([{ platform: 'Instagram', handle: '', artist: '', amount: '' }])
  const addSocialRow    = () => setSocialRows(prev => [...prev, { platform: 'Instagram', handle: '', artist: '', amount: '' }])
  const removeSocialRow = (i) => setSocialRows(prev => prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev)
  const updateSocialRow = (i, key, val) => setSocialRows(prev => prev.map((r, idx) => idx === i ? { ...r, [key]: val } : r))

  // Default boom_rep to the current user once auth resolves. The form-state
  // initial value can't read user yet (auth context resolves async after mount),
  // so seed it here. Only fills when blank so we don't clobber a prior selection.
  useEffect(() => {
    if (user?.name) {
      setForm(prev => prev.boom_rep ? prev : { ...prev, boom_rep: user.name })
    }
  }, [user?.name])
  const [parsingProof, setParsingProof] = useState(false)
  const [splitEnabled, setSplitEnabled] = useState(false)
  // Line items off a multi-line invoice, and what the parser said about them.
  // `lines` is the editable working copy — the parse fills it, the person fixes it.
  const [lines, setLines] = useState([])
  const [lineMeta, setLineMeta] = useState(null)

  useUnsavedWarning(!!form.payee || !!form.amount || !!form.description || !!file)
  const [artistSplits, setArtistSplits] = useState([{ artist: '', song: '', amount: '' }])
  // Distinct artists currently typed into the split editor — feeds the
  // per-handle "For artist" tag on the socials editor. Declared AFTER
  // artistSplits (const, so referencing it earlier would throw).
  const splitArtistOptions = splitEnabled
    ? [...new Set(artistSplits.map(s => (s.artist || '').trim()).filter(Boolean))]
    : []
  const [dupWarning, setDupWarning] = useState(null)
  const [similarInvoices, setSimilarInvoices] = useState([])
  // Invoice-document validation — same gating the vendor portal has.
  // Populated when handleParse runs; banner on the page renders any
  // issues + a mismatch warning if the typed invoice number doesn't
  // match what's printed on the document.
  const [invoiceValidation, setInvoiceValidation] = useState(null) // { valid, issues: string[], ... }
  const [docInvoiceNumber, setDocInvoiceNumber] = useState(null)   // string extracted from the document
  // W9 validation — auto-runs when the user attaches a W9 file. Surfaces
  // missing signature / missing date / "this is not actually a W9" etc.
  const [w9Validation, setW9Validation] = useState(null)
  const [w9Validating, setW9Validating] = useState(false)
  const [vendorSuggestions, setVendorSuggestions] = useState([])
  // null while idle/unknown; { has_w9, w9_entry_id, vendor } once we've
  // confirmed the typed payee matches an existing vendor exactly. We only
  // call /bk/vendor-w9-status on an exact match so the banner doesn't
  // flicker while the user is mid-typing.
  const [w9OnFile, setW9OnFile] = useState(null)

  // Debounced vendor suggestion when payee changes. Splits the response into
  // two paths: an exact name match (case-insensitive) auto-fills vendor_email
  // when the field is blank, while inexact matches surface as the suggestion
  // dropdown the user can click to fill in.
  useEffect(() => {
    if (!form.payee || form.payee.length < 2) { setVendorSuggestions([]); setW9OnFile(null); return }
    const timer = setTimeout(async () => {
      try {
        const res = await api.get('/bk/suggest-vendor', { params: { q: form.payee } })
        const suggestions = Array.isArray(res.data?.data) ? res.data.data : []
        const typed = form.payee.trim().toLowerCase()
        const exact = suggestions.find(v => v?.name && v.name.trim().toLowerCase() === typed)
        // On exact vendor match, fill any blank vendor-info fields from the
        // most-recent row on file. Never clobbers what the user has typed —
        // the ternary preserves whatever's already set.
        if (exact) {
          setForm(prev => ({
            ...prev,
            vendor_email:   prev.vendor_email   || exact.email   || prev.vendor_email,
            vendor_address: prev.vendor_address || exact.address || prev.vendor_address,
            vendor_bank:    prev.vendor_bank    || exact.bank    || prev.vendor_bank,
          }))
        }
        // Suggestion dropdown still shows non-exact matches.
        setVendorSuggestions(suggestions.filter(v => v?.name && v.name.toLowerCase() !== typed))

        // Only check W9 status when the typed payee exactly matches a known
        // vendor — partial typing would yield noisy false negatives.
        if (exact) {
          try {
            const r = await api.get('/bk/vendor-w9-status', { params: { payee: exact.name } })
            const w9 = r.data?.data || {}
            setW9OnFile(w9.has_w9 ? { has_w9: true, w9_entry_id: w9.w9_entry_id, vendor: w9.payee_on_file || exact.name } : null)
          } catch { setW9OnFile(null) }
        } else {
          setW9OnFile(null)
        }
      } catch { setVendorSuggestions([]); setW9OnFile(null) }
    }, 400)
    return () => clearTimeout(timer)
  }, [form.payee])

  // Debounced duplicate check when payee + invoice_number change
  useEffect(() => {
    if (!form.payee || !form.invoice_number) { setDupWarning(null); setSimilarInvoices([]); return }
    const timer = setTimeout(async () => {
      try {
        const res = await api.get('/bk/check-dup', { params: { payee: form.payee, invoice_number: form.invoice_number } })
        const data = res.data || {}
        setDupWarning(data.duplicate && data.entry ? data.entry : null)
        setSimilarInvoices(Array.isArray(data.similar) ? data.similar : [])
      } catch { setDupWarning(null); setSimilarInvoices([]) }
    }, 500)
    return () => clearTimeout(timer)
  }, [form.payee, form.invoice_number])

  const handleDrag = (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true)
    } else if (e.type === 'dragleave') {
      setDragActive(false)
    }
  }

  const handleDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const f = e.dataTransfer.files[0]
      if (['application/pdf', 'image/jpeg', 'image/png'].includes(f.type)) {
        setFile(f)
        setError('')
        // Old validation result belongs to the old file — wipe so the
        // banner doesn't lie until the next Parse runs.
        setInvoiceValidation(null)
        setDocInvoiceNumber(null)
      } else {
        setError('Only PDF, JPG, and PNG files are supported')
      }
    }
  }

  const handleFileChange = (e) => {
    if (e.target.files && e.target.files[0]) {
      const f = e.target.files[0]
      if (['application/pdf', 'image/jpeg', 'image/png'].includes(f.type)) {
        setFile(f)
        setError('')
        setInvoiceValidation(null)
        setDocInvoiceNumber(null)
      } else {
        setError('Only PDF, JPG, and PNG files are supported')
      }
    }
  }

  const handleParse = async () => {
    if (!file) return
    try {
      setParsing(true)
      setError('')
      setInvoiceValidation(null)
      setDocInvoiceNumber(null)
      // Run parse + validation + invoice-number extraction in parallel.
      // The cached-document option on the server means the underlying
      // Claude call only uploads the PDF once and reuses it for the
      // three prompts — round-trip cost is roughly one of them.
      const fdParse = new FormData(); fdParse.append('file', file)
      const fdValidate = new FormData(); fdValidate.append('file', file)
      const fdExtract = new FormData(); fdExtract.append('file', file)
      // LINE ITEMS, in the same round trip. A reimbursement sheet is twenty small
      // expenses stapled together — parsing it to one amount and one category made
      // a $2,564.38 blob whose description listed everything it had flattened.
      // Optional on purpose: a normal one-line invoice has no line items and this
      // simply returns an error, which must not disturb the parse that worked.
      const fdLines = new FormData(); fdLines.append('file', file)
      const [parseRes, validateRes, extractRes, linesRes] = await Promise.all([
        api.post('/bk/parse',                fdParse,    { headers: { 'Content-Type': 'multipart/form-data' } }),
        api.post('/bk/validate-invoice',     fdValidate, { headers: { 'Content-Type': 'multipart/form-data' } }).catch(() => ({ data: { valid: true, issues: [] } })),
        api.post('/bk/extract-invoice-number', fdExtract, { headers: { 'Content-Type': 'multipart/form-data' } }).catch(() => ({ data: { ok: false, invoice_number: null } })),
        api.post('/bk/parse-lines',          fdLines,    { headers: { 'Content-Type': 'multipart/form-data' } }).catch(() => ({ data: { success: false } })),
      ])
      const lineData = linesRes.data?.data || null
      if (lineData?.lines?.length) {
        setLines(lineData.lines.map((l, i) => ({
          key: `${i}-${l.n}`,
          description: [l.vendor, l.description].filter(Boolean).join(' — '),
          amount: String(l.amount.toFixed(2)),
          category: l.category || '',
          artist: l.artist || '',
          recoupable: !!l.recoupable,
        })))
        setLineMeta({ printed_total: lineData.printed_total, line_total: lineData.line_total,
          reconciles: lineData.reconciles, reason: lineData.reason,
          labels_from: lineData.labels_from, labels_error: lineData.labels_error })
      }
      const data = parseRes.data.data || {}
      // ai_status distinguishes: 'ok' = Claude ran and returned data;
      // 'disabled' = server has no ANTHROPIC_API_KEY (or CLAUDE_DISABLED
      // is on); 'error' = call happened but errored (JSON parse fail,
      // rate limit, timeout, etc). Older server builds don't send it —
      // treat missing status as 'ok' so we don't regress.
      const aiStatus = parseRes.data.ai_status || 'ok'
      const aiError  = parseRes.data.ai_error || null
      // Count how many non-empty fields Claude returned so the toast can
      // honestly report "AI couldn't extract fields — enter manually"
      // instead of pretending the parse succeeded when every field is null.
      const filledCount = ['invoice_date','payee','amount','invoice_number','category',
        'payment_method','artist','song','description','currency','vendor_email']
        .filter(k => data[k] != null && data[k] !== '').length
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
        vendor_email: data.vendor_email || prev.vendor_email,
        // Always credit the uploader as the rep — the AI doesn't know who's signed in.
        boom_rep: prev.boom_rep || user?.name || ''
      }))
      setInvoiceValidation(validateRes.data || { valid: true, issues: [] })
      setDocInvoiceNumber(extractRes.data?.invoice_number ?? null)
      // Synchronous duplicate sweep with the freshly parsed values —
      // the debounced effect would otherwise take 500ms to fire, leaving
      // a window where the post-parse toast says "success" but the
      // duplicate banner hasn't appeared yet. Run it here so the warning
      // lands in the same paint as the parse-success toast.
      const dupPayee = data.payee || form.payee
      const dupNum   = data.invoice_number || form.invoice_number
      let dupHit = null
      let similarHits = []
      if (dupPayee && dupNum) {
        try {
          const dupRes = await api.get('/bk/check-dup', {
            params: { payee: dupPayee, invoice_number: dupNum },
          })
          const dupData = dupRes.data || {}
          dupHit = (dupData.duplicate && dupData.entry) ? dupData.entry : null
          similarHits = Array.isArray(dupData.similar) ? dupData.similar : []
          setDupWarning(dupHit)
          setSimilarInvoices(similarHits)
        } catch { /* surface via the regular debounced effect on next tick */ }
      }
      // Enrich the post-parse toast with a duplicate-found hint so the
      // operator notices even if they're not looking at the Invoice #
      // field. The top-of-form banner below shows the detail. If the AI
      // returned zero populated fields, surface that instead of the
      // misleading "completed" — the user can't tell empty form + green
      // toast means "AI failed" without help.
      // Route the toast on the underlying reason so the user can act on
      // it. Zero fields + ai_status='ok' = document was genuinely
      // unreadable; zero fields + ai_status='disabled' = server has no
      // key so the whole parse pipeline is a no-op; zero fields +
      // ai_status='error' = call failed and the error string is worth
      // showing so ops can see rate-limit / timeout / etc.
      if (aiStatus === 'disabled') {
        setToast('AI is not configured on this server — enter fields manually below (ANTHROPIC_API_KEY missing)')
      } else if (aiStatus === 'error') {
        setToast(`AI parse failed — ${aiError || 'unknown error'}. Enter fields manually below.`)
      } else if (filledCount === 0) {
        setToast("AI ran but couldn't extract any fields — the document may be unreadable. Enter fields manually below.")
      } else if (dupHit) {
        setToast(`AI parsing completed — possible duplicate of entry #${dupHit.id}`)
      } else if (similarHits.length) {
        setToast(`AI parsing completed — similar invoice #${similarHits[0].invoice_number} already on file`)
      } else {
        setToast(`AI parsing completed — ${filledCount} field${filledCount === 1 ? '' : 's'} filled`)
      }
      setTimeout(() => setToast(''), 8000)
    } catch (err) {
      setError('Failed to parse file: ' + (err.response?.data?.error || err.message))
    } finally {
      setParsing(false)
    }
  }

  // Auto-validate W9 when the user attaches one. Optional file, so this
  // can no-op if the user never picks a W9. Fail-open on AI errors so a
  // hiccup doesn't block the workflow.
  useEffect(() => {
    if (!w9File) { setW9Validation(null); return }
    let cancelled = false
    setW9Validating(true)
    const fd = new FormData(); fd.append('file', w9File)
    api.post('/bk/validate-w9', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      .then(res => { if (!cancelled) setW9Validation(res.data || { valid: true, issues: [] }) })
      .catch(() => { if (!cancelled) setW9Validation({ valid: true, issues: [] }) })
      .finally(() => { if (!cancelled) setW9Validating(false) })
    return () => { cancelled = true }
  }, [w9File])

  const handleProofUpload = async (file) => {
    setProofFile(file)
    // Auto-mark as paid when proof is uploaded
    setForm(prev => ({ ...prev, payment_status: 'Paid' }))

    // AI scan proof to extract payment date
    if (file) {
      setParsingProof(true)
      try {
        const fd = new FormData()
        fd.append('file', file)
        const res = await api.post('/bk/parse-proof', fd, {
          headers: { 'Content-Type': 'multipart/form-data' }
        })
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
      } catch (_) {
        // fail silently — proof is still uploaded, just no auto-date
      } finally {
        setParsingProof(false)
      }
    }
  }

  // The uploaded invoice, previewable before it exists on the server.
  //
  // InlineFilePreview fetches whatever URL it is given and turns the response
  // into a blob URL; a `blob:` URL fetches straight back out of memory, so the
  // panel that shows a SAVED document also shows this one with no special case.
  // Revoked when the file changes, or a long session leaks one per upload.
  const localDocUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file])
  useEffect(() => () => { if (localDocUrl) URL.revokeObjectURL(localDocUrl) }, [localDocUrl])

  const handleFormChange = (field, value) => {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  // Everything that can refuse a save, with no writes and no side effects —
  // because the REVIEW must not open on a form that cannot be saved. Asking
  // somebody eight checklist questions and then telling them the vendor email is
  // missing is worse than not asking.
  const validationError = () => {
    if (!form.payee || !form.amount || !form.invoice_date || !(form.invoice_number || '').trim()) {
      return 'Payee, amount, invoice date, and invoice # are required'
    }
    const email = (form.vendor_email || '').trim()
    if (!email) return 'Vendor email is required'
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Please enter a valid vendor email address'
    // Non-admin gate: song + at least one social handle. Splits count —
    // a per-artist breakdown row carrying a song satisfies the song
    // requirement.
    if (!isAdminLevel) {
      const hasSong = (form.song || '').trim()
        || (splitEnabled && artistSplits.some(s => (s.song || '').trim()))
      if (!hasSong) return 'Song name is required'
      if (!socialRows.some(r => (r.handle || '').trim())) {
        return 'At least one social media handle is required'
      }
    }
    return null
  }

  // ── The review, before it files ───────────────────────────────────────────
  //
  // An admin's add is written `status = 'approved'` by the server on the spot
  // (POST /bk/entries), so it never reaches the Approvals queue and was never
  // asked the checklist every vendor-submitted invoice has to pass. Measured on
  // production 2026-08-27: 894 hand-added approved invoices worth $3,091,450
  // carry no checklist at all, and 771 of them read "recoupable" only because
  // the column defaults that way.
  //
  // So Save opens the SAME review — same questions, same component, same
  // implication rules (lib/approvalChecklist) — with the document you uploaded
  // beside it, and the completed checklist travels in the create payload.
  //
  // Not shown to non-admins: their row lands PENDING and an approver answers it
  // in the queue. Asking twice would be duplicated work, and letting a submitter
  // pre-answer their own approval is exactly what the server refuses to store.
  const handleSubmit = (e) => {
    if (e?.preventDefault) e.preventDefault()
    const bad = validationError()
    if (bad) { setError(bad); return }
    setError('')
    if (isAdminLevel) { setReviewChecks({}); setReviewOpen(true); return }
    return submitInvoice()
  }

  const submitInvoice = async (opts = {}) => {
    const bad = validationError()
    if (bad) { setError(bad); return }
    try {
      setSaving(true)
      setError('')
      // Translate the tri-state urgency selector into the server's
      // rush_requested / on_hold flags. Only sent when non-Paid — the
      // server also gates on payment_status but sending clean payloads
      // keeps the request/response symmetric with the Payment
      // Dashboard's flag endpoints. urgency + urgency_reason are
      // client-only fields; strip them from the outgoing payload.
      const { urgency, urgency_reason, ...formForServer } = form
      const isPaid = form.payment_status === 'Paid'
      const urgencyPayload =
        !isPaid && urgency === 'rush' ? { rush_requested: true, rush_reason: urgency_reason.trim() || null } :
        !isPaid && urgency === 'hold' ? { on_hold: true, hold_reason: urgency_reason.trim() || null } :
        {}
      const payload = {
        ...formForServer,
        ...urgencyPayload,
        // Server side, vendor-submitted rows use `vendor_name` (matches the
        // payee) — keep them aligned so alias lookups / duplicate checks
        // don't drift between admin-entered and vendor-submitted rows.
        vendor_name: form.payee,
        amount: parseFloat(form.amount),
        // Bypass the server's 409 duplicate gate only when the user has
        // explicitly clicked "Add anyway" after seeing the duplicate
        // they're about to create.
        ...(opts.forceDuplicate ? { force_duplicate: true } : {}),
        // The completed review. Validated server-side with the same
        // validateApprovalChecklist the approve route uses, BEFORE the insert —
        // a 400 afterwards would leave behind exactly the approved-and-never-
        // asked row this exists to prevent.
        ...(opts.checklist ? { checklist: opts.checklist } : {}),
      }
      // Socials — send only rows with a real handle. Same JSON shape the
      // vendor-submit form sends. Server stores on the JSONB social_handles
      // column; a missing key leaves it null (no clobber on unrelated saves).
      // An artist tag scopes the handle to one artist of a split invoice;
      // untagged handles are shared family-wide (matches the Artist
      // Campaigns display filter).
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
      // LINE ITEMS take precedence over the artist-only splitter. Slices carry
      // their own category, description and recoupable flag server-side, which is
      // the whole point — the 8 Oxis lines and the 2 QuickBooks lines must not end
      // up sharing one category.
      const usableLines = lines
        .map((l) => ({ ...l, amt: parseFloat(l.amount) }))
        .filter((l) => Number.isFinite(l.amt) && l.amt > 0)
      if (usableLines.length > 1) {
        payload.artist_breakdown = usableLines.map((l) => ({
          amount: l.amt,
          artist: l.artist || null,
          category: l.category || null,
          description: l.description || null,
          recoupable: !!l.recoupable,
        }))
        payload.amount = Math.round(usableLines.reduce((t, l) => t + l.amt, 0) * 100) / 100
        payload.artist = usableLines.find((l) => l.artist)?.artist || null
      } else if (splitEnabled) {
        const validSplits = artistSplits.filter(s => s.artist && s.amount)
        if (validSplits.length) {
          payload.artist_breakdown = validSplits.map(s => ({
            artist: s.artist,
            song: s.song,
            amount: parseFloat(s.amount)
          }))
          // The top-level Artist/Song fields are hidden in split mode, so
          // the primary row always derives from the first split — stale
          // values typed before the checkbox was ticked don't leak in.
          payload.artist = validSplits[0].artist
          if (validSplits[0].song) payload.song = validSplits[0].song
        }
      }
      const res = await api.post('/bk/entries', payload)
      const entryId = res.data.data?.id

      // Upload files if provided
      if (entryId) {
        const uploadFile = async (f, type) => {
          const fd = new FormData()
          fd.append('file', f)
          await api.post(`/bk/entries/${entryId}/file/${type}`, fd, {
            headers: { 'Content-Type': 'multipart/form-data' }
          })
        }
        if (file) await uploadFile(file, 'invoice').catch(() => {})
        if (w9File) await uploadFile(w9File, 'w9').catch(() => {})
        if (proofFile) await uploadFile(proofFile, 'proof').catch(() => {})
        // Reimbursement receipt — routed through the entity_files receipts
        // endpoint used by the ledger/approvals receipt upload flow, so the
        // file lives on the same expense_receipt entry_type as VendorSubmit's
        // reimbursement receipt.
        if (receiptFile && form.is_reimbursement) {
          const fd = new FormData()
          fd.append('file', receiptFile)
          await api.post(`/bk/entries/${entryId}/receipts`, fd, {
            headers: { 'Content-Type': 'multipart/form-data' }
          }).catch(() => {})
        }
      }

      setForm({
        invoice_date: '',
        payee: '',
        description: '',
        category: '',
        artist: '',
        song: '',
        invoice_number: '',
        amount: '',
        currency: 'USD',
        payment_method: '',
        boom_rep: user?.name || '',
        notes: '',
        cobrand: false,
        is_reimbursement: false,
        is_bulk_deal: false,
        bulk_deal_quantity: '',
        bulk_deal_unit: '',
        vendor_email: '',
        vendor_address: '',
        vendor_bank: '',
        payment_status: 'Unpaid',
        payment_date: '',
        payment_ref: '',
        urgency: 'none',
        urgency_reason: '',
      })
      setSocialRows([{ platform: 'Instagram', handle: '', artist: '', amount: '' }])
      setSplitEnabled(false)
      setArtistSplits([{ artist: '', song: '', amount: '' }])
      setFile(null)
      setW9File(null)
      setProofFile(null)
      setReceiptFile(null)
      setReviewOpen(false)
      setReviewChecks({})
      setSuccess(true)
      setTimeout(() => setSuccess(false), 5000)
    } catch (err) {
      // The server's 409 dup-gate returns a structured payload with the
      // existing entry. Surface a confirm prompt so the user can either
      // back off (don't add the dup) or override (e.g., legit case of two
      // invoices that happen to share a normalized number).
      if (err.response?.status === 409 && err.response?.data?.duplicate) {
        const d = err.response.data.duplicate
        const amt = d.amount != null
          ? Number(d.amount).toLocaleString('en-US', { style: 'currency', currency: d.currency || 'USD' })
          : '—'
        const ok = window.confirm(
          `Invoice #${d.invoice_number} is already on file for ${d.payee || form.payee} (entry #${d.id}, ${amt}, ${d.payment_status || 'Unpaid'}).\n\nAdd anyway?`
        )
        if (ok) {
          setSaving(false)
          // opts, not a fresh object: the review has already been completed and
          // re-asking for it here would be the same eight questions again.
          return submitInvoice({ ...opts, forceDuplicate: true })
        }
        setError(`Skipped: invoice #${d.invoice_number} is already on file for ${d.payee || form.payee} (entry #${d.id}).`)
      } else {
        setError('Failed to save invoice: ' + (err.response?.data?.error || err.message))
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-surface-50 p-6">
      <div className="max-w-3xl mx-auto">
        <PageHeader tour="add-invoice-header" title="Add Invoice" subtitle="Upload and parse vendor invoices" />

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-lg mb-6 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-medium">Error</p>
              <p className="text-sm">{error}</p>
            </div>
          </div>
        )}

        {toast && (
          <div className="bg-blue-50 border border-blue-200 text-blue-800 px-4 py-3 rounded-lg mb-6">
            {toast}
          </div>
        )}

        {success && (
          <div className="bg-green-50 border border-green-200 text-green-800 px-4 py-3 rounded-lg mb-6 flex items-start gap-3">
            <CheckCircle className="w-5 h-5 mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-medium">Invoice saved successfully!</p>
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* File upload area */}
          <div data-tour="add-invoice-upload"
            className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition ${
              dragActive
                ? 'border-boom-600 bg-boom-50'
                : 'border-gray-300 bg-card hover:border-gray-400'
            }`}
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              hidden
              accept=".pdf,.jpg,.jpeg,.png"
              onChange={handleFileChange}
            />
            {file ? (
              <div className="text-green-600">
                <CheckCircle className="w-8 h-8 mx-auto mb-2" />
                <p className="font-medium">{file.name}</p>
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

          {file && (
            <button
              type="button"
              onClick={handleParse}
              disabled={parsing}
              className="w-full px-4 py-3 bg-boom-600 text-white rounded-lg hover:bg-boom-700 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {parsing && <Loader className="w-4 h-4 animate-spin" />}
              {parsing ? 'Parsing with AI...' : 'Parse with AI'}
            </button>
          )}

          {/* Possible-duplicate banner — surfaces the same dupWarning /
              similarInvoices state that powers the inline warning by the
              Invoice # field, but at the TOP of the form so it can't be
              missed. Especially important right after Parse populates
              the form with values that match an existing row. */}
          {(dupWarning || similarInvoices.length > 0) && (
            <div className="rounded-lg border border-amber-400 bg-amber-50 px-3 py-2.5 text-xs text-amber-900">
              <div className="font-bold mb-1 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5" />
                {dupWarning ? 'Possible duplicate invoice' : 'Similar invoice number already on file'}
              </div>
              {dupWarning && (
                <p>
                  Invoice <strong>#{form.invoice_number}</strong> for <strong>{form.payee}</strong> already
                  exists as entry <strong>#{dupWarning.id}</strong>
                  {dupWarning.amount != null && <> — {Number(dupWarning.amount).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}</>}
                  {/* Say so when the figure is a family total. It used to be one row's
                      share of a split, with the link pointing at that row; both now
                      resolve to the invoice, and naming the split is what makes the
                      bigger number make sense. */}
                  {dupWarning.child_rows > 0 && (
                    <> <span className="font-semibold">split across {dupWarning.child_rows + 1} artists</span></>
                  )}
                  {dupWarning.payment_status && <> ({dupWarning.payment_status})</>}
                  {dupWarning.invoice_date && <> · dated {String(dupWarning.invoice_date).slice(0, 10)}</>}
                  {/* WHERE it is, not just that it exists. This warning always
                      linked to the ledger, but the ledger only shows APPROVED
                      rows — so for an entry still awaiting approval the link led
                      to a page that structurally could not display it, and the
                      search that followed found nothing. John hit exactly that:
                      entry 1659, pending, invisible in the ledger. */}
                  {dupWarning.status && dupWarning.status !== 'approved'
                    && <> · <strong>{dupWarning.status === 'pending' ? 'awaiting approval' : dupWarning.status}</strong></>}.
                  {' '}
                  {dupWarning.status && dupWarning.status !== 'approved' ? (
                    <a href="/bk/approvals" className="underline font-semibold hover:text-amber-700" target="_blank" rel="noreferrer">
                      Open in Approvals →
                    </a>
                  ) : (
                    <a href={`/bk/ledger?focus=${dupWarning.id}`} className="underline font-semibold hover:text-amber-700" target="_blank" rel="noreferrer">
                      Open existing entry →
                    </a>
                  )}
                  {dupWarning.status === 'pending' && (
                    <span className="block text-[11px] text-amber-700/80 mt-0.5">
                      It is not in the ledger yet — the ledger lists approved entries only, which is why searching for it there finds nothing.
                    </span>
                  )}
                </p>
              )}
              {!dupWarning && similarInvoices.length > 0 && (
                <ul className="space-y-0.5">
                  {similarInvoices.map((inv, i) => (
                    <li key={inv?.id || i}>
                      <strong>#{inv?.invoice_number}</strong>
                      {inv?.amount != null && <> — {Number(inv.amount).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}</>}
                      {inv?.payment_status && <> ({inv.payment_status})</>}
                      {' '}<a href={`/bk/ledger?focus=${inv?.id}`} className="underline hover:text-amber-700" target="_blank" rel="noreferrer">open →</a>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-1.5 text-[10px] text-amber-700 opacity-80">
                If this is genuinely a new invoice (e.g. a reissue with the same number), you can still save —
                the server will warn again on submit. The flag is informational.
              </p>
            </div>
          )}

          {/* Invoice validation banner — mirrors the vendor portal gate.
              Renders only after Parse runs (invoiceValidation populated).
              !valid -> red banner with bulleted issues. valid -> green
              acknowledgement chip with the structured signals so staff
              can see what the AI confirmed. */}
          {invoiceValidation && (
            invoiceValidation.valid === false ? (
              <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2.5 text-xs text-red-800">
                <div className="font-bold mb-1 flex items-center gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5" />
                  This document doesn't look like a proper invoice
                </div>
                <ul className="list-disc list-inside space-y-0.5 ml-1">
                  {(invoiceValidation.issues || []).map((s, i) => <li key={i}>{s}</li>)}
                </ul>
                <p className="mt-1.5 text-[10px] text-red-700 opacity-80">
                  You can still save the entry but the document fails one or more standard invoice checks.
                </p>
              </div>
            ) : (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-800 flex items-center gap-1.5">
                <CheckCircle className="w-3.5 h-3.5" />
                Invoice passes the standard checks
                {invoiceValidation.has_invoice_number === false && (
                  <span className="ml-auto text-amber-700">· no invoice # printed</span>
                )}
              </div>
            )
          )}

          {/* Doc-vs-typed invoice-number mismatch. Same cross-check the
              vendor portal applies at submit. Only shown when both
              sides exist and differ (after normalization). */}
          {docInvoiceNumber && form.invoice_number && (() => {
            const a = normalizeInvoiceNum(docInvoiceNumber)
            const b = normalizeInvoiceNum(form.invoice_number)
            if (a === b) return null
            return (
              <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <div>
                  Typed invoice <strong>#{form.invoice_number}</strong> doesn't match
                  the number on the document (<strong>#{docInvoiceNumber}</strong>).
                  Double-check before saving.
                </div>
              </div>
            )
          })()}

          {/* Reimbursement mode toggle. Sits above the auxiliary file grid
              because it changes what appears there (Receipt slot only shows
              when reimbursement is on). Mirrors the vendor-submit workflow. */}
          <label className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium cursor-pointer transition ${
            form.is_reimbursement
              ? 'border-boom-300 bg-boom-50 text-boom-800'
              : 'border-gray-200 bg-card text-gray-600 hover:border-gray-300'
          }`}>
            <input
              type="checkbox"
              checked={form.is_reimbursement}
              onChange={e => {
                const next = e.target.checked
                handleFormChange('is_reimbursement', next)
                if (!next) setReceiptFile(null)
              }}
              className="rounded border-gray-300"
            />
            <Receipt size={14} className={form.is_reimbursement ? 'text-boom-600' : 'text-gray-400'} />
            This is a reimbursement
            <span className="ml-auto text-xs text-gray-400 font-normal">
              {form.is_reimbursement ? 'Receipt upload enabled below' : 'Reimburses staff for an out-of-pocket expense'}
            </span>
          </label>

          {/* Bulk-deal marker. Sits with the reimbursement toggle because both
              answer "what KIND of invoice is this" before the file grid.
              Quantity and unit only appear once it is on — they are meaningless
              otherwise, and the server drops them if they arrive without the flag
              rather than leaving orphan values a later toggle would resurrect.

              The approval checklist still ASKS this (CHECKLIST_ANSWER in
              routes/bookkeeping.js): `is_bulk_deal` is BOOLEAN DEFAULT FALSE, so
              an unticked box here is indistinguishable from nobody looking, and
              the checklist answer stays the only record of a decision. What
              changes is that the approver now sees what was submitted. */}
          <div className={`rounded-lg border px-3 py-2 transition ${
            form.is_bulk_deal
              ? 'border-boom-300 bg-boom-50'
              : 'border-gray-200 bg-card hover:border-gray-300'
          }`}>
            <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
              <input
                type="checkbox"
                checked={form.is_bulk_deal}
                onChange={e => {
                  const next = e.target.checked
                  handleFormChange('is_bulk_deal', next)
                  // Clear the detail when switching off, so a stale "30 posts"
                  // cannot ride along on a later save.
                  if (!next) {
                    handleFormChange('bulk_deal_quantity', '')
                    handleFormChange('bulk_deal_unit', '')
                  }
                }}
                className="rounded border-gray-300"
              />
              <Package size={14} className={form.is_bulk_deal ? 'text-boom-600' : 'text-gray-400'} />
              <span className={form.is_bulk_deal ? 'text-boom-800' : 'text-gray-600'}>This is a bulk deal</span>
              <span className="ml-auto text-xs text-gray-400 font-normal">
                {form.is_bulk_deal
                  ? 'Tracked on Bulk Deals with per-deliverable completion'
                  : 'Several deliverables bought together — posts, videos, edits'}
              </span>
            </label>
            {form.is_bulk_deal && (
              <div className="mt-2 flex flex-wrap items-center gap-2 pl-6">
                <input
                  type="number" min="1" step="1"
                  value={form.bulk_deal_quantity}
                  onChange={e => handleFormChange('bulk_deal_quantity', e.target.value)}
                  placeholder="How many"
                  className="w-28 px-2 py-1 text-sm border border-gray-300 rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400 tabular-nums"
                />
                <input
                  type="text"
                  value={form.bulk_deal_unit}
                  onChange={e => handleFormChange('bulk_deal_unit', e.target.value)}
                  placeholder="of what — posts, videos, edits…"
                  className="flex-1 min-w-[12rem] px-2 py-1 text-sm border border-gray-300 rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400"
                />
                <span className="text-xs text-gray-400">
                  Optional — the deliverables themselves are tracked on Bulk Deals
                </span>
              </div>
            )}
          </div>

          {/* W9, Proof, and (when reimbursement) Receipt uploads */}
          <div className={`grid gap-4 ${form.is_reimbursement ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-1 sm:grid-cols-2'}`}>
            <div
              className={`border-2 border-dashed rounded-lg p-5 text-center cursor-pointer transition ${
                w9File ? 'border-green-400 bg-green-50' : 'border-gray-300 bg-card hover:border-gray-400'
              }`}
              onClick={() => {
                const input = document.createElement('input')
                input.type = 'file'
                input.accept = '.pdf,.jpg,.jpeg,.png'
                input.onchange = e => {
                  const f = e.target.files?.[0]
                  if (f) setW9File(f)
                }
                input.click()
              }}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) setW9File(f) }}
            >
              {w9File ? (
                <div className="text-green-600">
                  <CheckCircle className="w-6 h-6 mx-auto mb-1" />
                  <p className="text-sm font-medium truncate">{w9File.name}</p>
                  <button type="button" onClick={e => { e.stopPropagation(); setW9File(null) }} className="text-xs text-red-500 mt-1 hover:underline">Remove</button>
                </div>
              ) : w9OnFile?.has_w9 ? (
                <div className="text-emerald-700">
                  <ShieldCheck className="w-6 h-6 mx-auto mb-1 text-emerald-500" />
                  <p className="text-sm font-medium">Already on file</p>
                  <p className="text-xs text-emerald-600">Only upload if updated</p>
                </div>
              ) : (
                <div className="text-gray-500">
                  <Upload className="w-6 h-6 mx-auto mb-1 text-gray-400" />
                  <p className="text-sm font-medium">W9 / W8 Form</p>
                  <p className="text-xs text-gray-400">Optional</p>
                </div>
              )}
            </div>
            <div
              className={`border-2 border-dashed rounded-lg p-5 text-center cursor-pointer transition ${
                proofFile ? 'border-green-400 bg-green-50' : 'border-gray-300 bg-card hover:border-gray-400'
              }`}
              onClick={() => {
                const input = document.createElement('input')
                input.type = 'file'
                input.accept = '.pdf,.jpg,.jpeg,.png'
                input.onchange = e => {
                  const f = e.target.files?.[0]
                  if (f) handleProofUpload(f)
                }
                input.click()
              }}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) handleProofUpload(f) }}
            >
              {proofFile ? (
                <div className="text-green-600">
                  <CheckCircle className="w-6 h-6 mx-auto mb-1" />
                  <p className="text-sm font-medium truncate">{proofFile.name}</p>
                  {parsingProof && <p className="text-xs text-blue-500 mt-1 animate-pulse">Scanning for payment date...</p>}
                  <button type="button" onClick={e => { e.stopPropagation(); setProofFile(null); setForm(prev => ({ ...prev, payment_status: 'Unpaid', payment_date: '' })) }} className="text-xs text-red-500 mt-1 hover:underline">Remove</button>
                </div>
              ) : (
                <div className="text-gray-500">
                  <Upload className="w-6 h-6 mx-auto mb-1 text-gray-400" />
                  <p className="text-sm font-medium">Proof of Payment</p>
                  <p className="text-xs text-gray-400">Auto-marks as paid</p>
                </div>
              )}
            </div>
            {form.is_reimbursement && (
              <div
                className={`border-2 border-dashed rounded-lg p-5 text-center cursor-pointer transition ${
                  receiptFile ? 'border-green-400 bg-green-50' : 'border-gray-300 bg-card hover:border-gray-400'
                }`}
                onClick={() => {
                  const input = document.createElement('input')
                  input.type = 'file'
                  input.accept = '.pdf,.jpg,.jpeg,.png'
                  input.onchange = e => {
                    const f = e.target.files?.[0]
                    if (f) setReceiptFile(f)
                  }
                  input.click()
                }}
                onDragOver={e => e.preventDefault()}
                onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) setReceiptFile(f) }}
              >
                {receiptFile ? (
                  <div className="text-green-600">
                    <CheckCircle className="w-6 h-6 mx-auto mb-1" />
                    <p className="text-sm font-medium truncate">{receiptFile.name}</p>
                    <button type="button" onClick={e => { e.stopPropagation(); setReceiptFile(null) }} className="text-xs text-red-500 mt-1 hover:underline">Remove</button>
                  </div>
                ) : (
                  <div className="text-gray-500">
                    <Receipt className="w-6 h-6 mx-auto mb-1 text-gray-400" />
                    <p className="text-sm font-medium">Receipt</p>
                    <p className="text-xs text-gray-400">Proof of out-of-pocket expense</p>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* W9 validation banner — auto-runs when a W9 file is attached.
              Same gating the vendor portal applies. !valid renders the
              specific issues (missing signature, missing date, wrong
              form type, etc.); valid renders a small acknowledgement so
              staff know the check ran. */}
          {w9File && (
            w9Validating ? (
              <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-[11px] text-gray-600 flex items-center gap-1.5">
                <Loader className="w-3.5 h-3.5 animate-spin" />
                Verifying W9 / W8 form…
              </div>
            ) : w9Validation && w9Validation.valid === false ? (
              <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2.5 text-xs text-red-800">
                <div className="font-bold mb-1 flex items-center gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5" />
                  W9 / W8 form has issues
                </div>
                <ul className="list-disc list-inside space-y-0.5 ml-1">
                  {(w9Validation.issues || []).map((s, i) => <li key={i}>{s}</li>)}
                </ul>
                <p className="mt-1.5 text-[10px] text-red-700 opacity-80">
                  {w9Validation.form_type && w9Validation.form_type !== 'unknown' && `Detected ${w9Validation.form_type}. `}
                  You can still save but the document fails one or more standard tax-form checks.
                </p>
              </div>
            ) : w9Validation ? (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-800 flex items-center gap-2 flex-wrap">
                <CheckCircle className="w-3.5 h-3.5" />
                W9 / W8 form looks complete
                {w9Validation.form_type && w9Validation.form_type !== 'unknown' && (
                  <span className="text-emerald-700">· {w9Validation.form_type}</span>
                )}
                {w9Validation.is_signed && <span className="text-emerald-700">· signed</span>}
                {w9Validation.is_dated  && <span className="text-emerald-700">· dated</span>}
              </div>
            ) : null
          )}

          {/* Form fields */}
          <div data-tour="add-invoice-fields" className="bg-card rounded-lg shadow p-6 space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Invoice Date *</label>
                <input
                  type="date"
                  required
                  value={form.invoice_date}
                  onChange={e => handleFormChange('invoice_date', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-boom-600 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Payee *</label>
                <input
                  type="text"
                  required
                  value={form.payee}
                  onChange={e => handleFormChange('payee', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-boom-600 focus:border-transparent"
                />
                {vendorSuggestions.length > 0 && (
                  <div className="mt-1 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
                    <p className="text-xs text-blue-600 font-medium mb-1">Did you mean?</p>
                    <div className="flex flex-wrap gap-1.5">
                      {vendorSuggestions.map(v => (
                        <button
                          key={v.name}
                          type="button"
                          onClick={() => { handleFormChange('payee', v.name); if (v.email) handleFormChange('vendor_email', v.email); setVendorSuggestions([]) }}
                          className="text-xs font-semibold text-blue-700 bg-blue-100 hover:bg-blue-200 px-2 py-1 rounded transition-colors"
                        >
                          {v.name} ({v.invoice_count} inv)
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {w9OnFile?.has_w9 && (
                  <div className="mt-1.5 flex items-center justify-between gap-2 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <ShieldCheck className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                      <p className="text-xs text-emerald-700">
                        W9 already on file for <strong>{w9OnFile.vendor}</strong>
                      </p>
                    </div>
                    {w9OnFile.w9_entry_id && (
                      <a
                        href={`${api.defaults.baseURL}/bk/entries/${w9OnFile.w9_entry_id}/file/w9?token=${localStorage.getItem('token')}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs font-semibold text-emerald-700 hover:text-emerald-900 underline whitespace-nowrap"
                      >
                        Preview
                      </a>
                    )}
                  </div>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                <select
                  value={form.category}
                  onChange={e => handleFormChange('category', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-boom-600 focus:border-transparent"
                >
                  <option value="">Select category</option>
                  {CATEGORIES.map(cat => (
                    <option key={cat} value={cat}>{cat}</option>
                  ))}
                </select>
              </div>
              {/* In split mode the artist/song live on the split rows —
                  showing editable fields here too caused double entry and
                  contradictions with the breakdown below. */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Artist</label>
                {splitEnabled ? (
                  <div className="w-full px-3 py-2 border border-dashed border-boom-300 bg-boom-50/60 rounded-lg text-sm font-medium text-boom-700">
                    {(() => { const n = artistSplits.filter(s => s.artist.trim()).length; return n > 0 ? `Split across ${n} artist${n === 1 ? '' : 's'} — set below` : 'Set per artist in the split below' })()}
                  </div>
                ) : (
                  <input
                    type="text"
                    value={form.artist}
                    onChange={e => handleFormChange('artist', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-boom-600 focus:border-transparent"
                  />
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Song{!isAdminLevel && !splitEnabled && ' *'}</label>
                {splitEnabled ? (
                  <div className="w-full px-3 py-2 border border-dashed border-boom-300 bg-boom-50/60 rounded-lg text-sm font-medium text-boom-700">
                    Set per artist in the split below
                  </div>
                ) : (
                  <input
                    type="text"
                    value={form.song}
                    onChange={e => handleFormChange('song', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-boom-600 focus:border-transparent"
                  />
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Invoice # *</label>
                <input
                  type="text"
                  required
                  value={form.invoice_number}
                  onChange={e => handleFormChange('invoice_number', e.target.value)}
                  className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-boom-600 focus:border-transparent ${dupWarning || similarInvoices.length ? 'border-amber-400 bg-amber-50' : 'border-gray-300'}`}
                />
                {dupWarning && typeof dupWarning === 'object' && (
                  <div className="flex items-start gap-2 mt-1.5 text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                    <p className="text-xs">
                      Invoice <strong>#{form.invoice_number}</strong> already on file for <strong>{form.payee}</strong>
                      {dupWarning.amount != null && <> — {Number(dupWarning.amount).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}</>}
                      {dupWarning.child_rows > 0 && (
                        <> <span className="font-semibold">split across {dupWarning.child_rows + 1} artists</span></>
                      )}
                      {dupWarning.payment_status && <> ({dupWarning.payment_status})</>}
                    </p>
                  </div>
                )}
                {!dupWarning && Array.isArray(similarInvoices) && similarInvoices.length > 0 && (
                  <div className="flex items-start gap-2 mt-1.5 text-orange-700 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2">
                    <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                    <div className="text-xs">
                      <p className="font-medium mb-1">Similar invoice number{similarInvoices.length > 1 ? 's' : ''} found for {form.payee}:</p>
                      {similarInvoices.map((inv, idx) => (
                        <p key={inv?.id || idx}>
                          <strong>#{inv?.invoice_number || '?'}</strong>
                          {inv?.amount != null && <> — {Number(inv.amount).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}</>}
                          {inv?.payment_status && <> ({inv.payment_status})</>}
                        </p>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Amount *</label>
                <input
                  type="number"
                  step="0.01"
                  required
                  value={form.amount}
                  onChange={e => handleFormChange('amount', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-boom-600 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Currency</label>
                <select
                  value={form.currency}
                  onChange={e => handleFormChange('currency', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-boom-600 focus:border-transparent"
                >
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                  <option value="GBP">GBP</option>
                  <option value="CAD">CAD</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Payment Method</label>
                <select
                  value={form.payment_method}
                  onChange={e => handleFormChange('payment_method', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-boom-600 focus:border-transparent"
                >
                  <option value="">Select method</option>
                  {PAYMENT_METHODS.map(method => (
                    <option key={method} value={method}>{method}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">market.st Rep</label>
                <select
                  value={form.boom_rep}
                  onChange={e => handleFormChange('boom_rep', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-boom-600 focus:border-transparent bg-white"
                >
                  <option value="">Select rep</option>
                  {repOptions.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Vendor Email <span className="text-red-600">*</span></label>
                <input
                  type="email"
                  value={form.vendor_email}
                  onChange={e => handleFormChange('vendor_email', e.target.value)}
                  placeholder="vendor@example.com"
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-boom-600 focus:border-transparent"
                />
              </div>
              {/* Mirror the vendor-submit form: capture mailing address +
                  bank name so payment routing info is on file with the same
                  fidelity as vendor-portal submissions. Both optional here
                  (staff often add these on a follow-up); the vendor portal
                  requires them for public submissions but that's the vendor
                  side of the same contract. */}
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">Mailing Address</label>
                <input
                  type="text"
                  value={form.vendor_address}
                  onChange={e => handleFormChange('vendor_address', e.target.value)}
                  placeholder="Street address, City, State, ZIP"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-boom-600 focus:border-transparent"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Bank Name <span className="text-gray-400 text-xs font-normal">— for payment routing</span>
                </label>
                <input
                  type="text"
                  value={form.vendor_bank}
                  onChange={e => handleFormChange('vendor_bank', e.target.value)}
                  placeholder="e.g. Chase, Bank of America, Wells Fargo"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-boom-600 focus:border-transparent"
                />
              </div>
            </div>

            {/* Social handles — same editor the vendor-submit form uses.
                Stored on the JSONB social_handles column so the row
                shows up with real socials in Flags → Missing Socials and the
                Marketing / PR reconciliation views instead of an empty chip.
                Required (at least one handle) for non-admin submitters. */}
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
                {(
                  <button
                    type="button"
                    onClick={addSocialRow}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold text-gray-500 hover:text-boom-600 hover:bg-boom-50 transition-colors"
                  >
                    <Plus size={12} /> Add another handle
                  </button>
                )}
              </div>
            </div>

            {/* Artist Split */}
            <div>
              <label className="flex items-center gap-2 cursor-pointer mb-2">
                <input
                  type="checkbox"
                  checked={splitEnabled}
                  onChange={e => setSplitEnabled(e.target.checked)}
                  className="rounded border-gray-300"
                />
                <span className="text-sm font-medium text-gray-700">Split between multiple artists</span>
              </label>
              {/* ── LINE ITEMS ─────────────────────────────────────────────────
                  A reimbursement sheet is twenty small expenses stapled together,
                  and each one wants its own category, artist and recoupable flag.
                  The amounts arrive from the DOCUMENT TEXT, checked against the
                  total the sheet prints; the categories and artists are the model's
                  suggestions and are meant to be corrected here. */}
              {lines.length > 0 && (() => {
                const nums = lines.map((l) => parseFloat(l.amount)).map((n) => (Number.isFinite(n) ? n : 0))
                const sum = Math.round(nums.reduce((a, b) => a + b, 0) * 100) / 100
                const target = Math.round((parseFloat(form.amount) || 0) * 100) / 100
                const diff = Math.round((sum - target) * 100) / 100
                const set = (i, field, value) => setLines((prev) =>
                  prev.map((l, ix) => (ix === i ? { ...l, [field]: value } : l)))
                const cell = 'w-full border border-gray-200 rounded px-2 py-1 text-[12.5px] outline-none focus:border-boom-400'
                return (
                  <div className="mt-4 border border-gray-200 rounded-lg overflow-hidden">
                    <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="text-xs font-extrabold uppercase tracking-wide text-gray-600">
                        {lines.length} line items
                      </span>
                      {/* Where each half came from, so nobody reads the categories
                          as arithmetic or the amounts as a guess. */}
                      <span className="text-[11px] text-gray-500">
                        amounts read from the document
                        {lineMeta?.reconciles
                          ? ` and checked against its printed total of $${Number(lineMeta.printed_total).toFixed(2)}`
                          : lineMeta?.reason ? ` — NOT verified: ${lineMeta.reason}` : ''}
                        {lineMeta?.labels_from === 'ai'
                          ? ' · categories and artists are AI suggestions — correct them here'
                          : lineMeta?.labels_error ? ` · no category suggestions (${lineMeta.labels_error})` : ''}
                      </span>
                    </div>
                    <div className="max-h-[22rem] overflow-y-auto">
                      <table className="w-full text-[12.5px]">
                        <thead className="sticky top-0 bg-white border-b border-gray-200">
                          <tr className="text-[10px] uppercase tracking-wide text-gray-500">
                            <th className="text-left px-2 py-1.5 font-extrabold">Description</th>
                            <th className="text-left px-2 py-1.5 font-extrabold w-44">Category</th>
                            <th className="text-left px-2 py-1.5 font-extrabold w-36">Artist</th>
                            <th className="text-right px-2 py-1.5 font-extrabold w-24">Amount</th>
                            <th className="text-center px-2 py-1.5 font-extrabold w-16" title="Recoupable from the artist. Defaults on only when the line names one — the column defaults TRUE in the database, so leaving it alone would put subscriptions and rides onto Recoupments against nobody.">Recoup</th>
                            <th className="w-8" />
                          </tr>
                        </thead>
                        <tbody>
                          {lines.map((l, i) => (
                            <tr key={l.key || i} className="border-b border-gray-100 last:border-0">
                              <td className="px-2 py-1">
                                <input className={cell} value={l.description}
                                  onChange={(e) => set(i, 'description', e.target.value)} />
                              </td>
                              <td className="px-2 py-1">
                                <select className={cell} value={l.category}
                                  onChange={(e) => set(i, 'category', e.target.value)}>
                                  <option value="">— pick —</option>
                                  {(l.category && !CATEGORIES.includes(l.category)) && (
                                    <option value={l.category}>{l.category}</option>
                                  )}
                                  {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                                </select>
                              </td>
                              <td className="px-2 py-1">
                                <input className={cell} value={l.artist}
                                  placeholder="— none —"
                                  onChange={(e) => set(i, 'artist', e.target.value)} />
                              </td>
                              <td className="px-2 py-1">
                                <input className={`${cell} text-right font-mono`} value={l.amount}
                                  inputMode="decimal"
                                  onChange={(e) => set(i, 'amount', e.target.value)} />
                              </td>
                              <td className="px-2 py-1 text-center">
                                <input type="checkbox" checked={!!l.recoupable}
                                  onChange={(e) => set(i, 'recoupable', e.target.checked)} />
                              </td>
                              <td className="px-1 py-1 text-center">
                                <button type="button" title="Remove this line"
                                  onClick={() => setLines((prev) => prev.filter((_, ix) => ix !== i))}
                                  className="text-gray-300 hover:text-red-500">
                                  <Trash2 size={13} />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {/* THE TIE-OUT. Saving twenty lines that do not add up to the
                        invoice is how a ledger stops reconciling, so the difference
                        is stated in words and the button below is blocked on it. */}
                    <div className="px-3 py-2 bg-gray-50 border-t border-gray-200 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-3">
                        <button type="button"
                          onClick={() => setLines((prev) => [...prev, { key: `new-${prev.length}-${Date.now()}`, description: '', amount: '', category: '', artist: '', recoupable: false }])}
                          className="text-[11.5px] font-bold text-gray-500 hover:text-boom-600">+ add line</button>
                        {diff !== 0 && lines.length > 0 && (
                          <button type="button"
                            title="Put the difference on the last line, so the lines tie to the invoice."
                            onClick={() => setLines((prev) => prev.map((l, ix) => (ix === prev.length - 1
                              ? { ...l, amount: (Math.round(((parseFloat(l.amount) || 0) - diff) * 100) / 100).toFixed(2) }
                              : l)))}
                            className="text-[11.5px] font-bold text-boom-600 hover:underline">
                            put the remainder on the last line
                          </button>
                        )}
                      </div>
                      <div className="text-[12px] font-mono">
                        <span className="text-gray-500">lines</span> ${sum.toFixed(2)}
                        <span className="text-gray-400"> / invoice </span>${target.toFixed(2)}
                        {diff === 0
                          ? <span className="ml-2 font-sans font-bold text-emerald-600">ties out</span>
                          : <span className="ml-2 font-sans font-bold text-red-600">
                              {diff > 0 ? `over by $${diff.toFixed(2)}` : `$${Math.abs(diff).toFixed(2)} left`}
                            </span>}
                      </div>
                    </div>
                  </div>
                )
              })()}
              {splitEnabled && (() => {
                const splitSum = artistSplits.reduce((s, sp) => s + parseFloat(sp.amount || 0), 0)
                const total = parseFloat(form.amount || 0)
                const remaining = total - splitSum
                const balanced = Math.abs(remaining) < 0.01 && total > 0
                return (
                <div className="rounded-xl border-2 border-boom-200 bg-boom-50/40 overflow-hidden">
                  <div className="px-4 py-2.5 bg-boom-50 border-b border-boom-100 flex items-center justify-between">
                    <span className="text-xs font-bold text-boom-800 uppercase tracking-wide">Artist split</span>
                    <span className="text-[11px] text-boom-700/70">Each row becomes its own ledger entry with its own toggles</span>
                  </div>
                  <div className="p-4 space-y-2">
                    {/* Column labels */}
                    <div className="flex gap-2 items-center text-[10px] font-bold uppercase tracking-wide text-gray-400 px-1">
                      <span className="w-5" />
                      <span className="flex-1">Artist</span>
                      <span className="flex-1">Song</span>
                      <span className="w-28">Amount</span>
                      {artistSplits.length > 1 && <span className="w-8" />}
                    </div>
                    {artistSplits.map((split, idx) => (
                      <div key={idx} className="flex gap-2 items-center">
                        <span className="w-5 text-center text-[11px] font-black text-boom-300">{idx + 1}</span>
                        <input
                          type="text"
                          value={split.artist}
                          onChange={e => setArtistSplits(prev => prev.map((s, i) => i === idx ? { ...s, artist: e.target.value } : s))}
                          placeholder="Artist"
                          className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm bg-card focus:ring-2 focus:ring-boom-600 focus:border-transparent"
                        />
                        <input
                          type="text"
                          value={split.song}
                          onChange={e => setArtistSplits(prev => prev.map((s, i) => i === idx ? { ...s, song: e.target.value } : s))}
                          placeholder="Song (optional)"
                          className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm bg-card focus:ring-2 focus:ring-boom-600 focus:border-transparent"
                        />
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={split.amount}
                          onChange={e => setArtistSplits(prev => prev.map((s, i) => i === idx ? { ...s, amount: e.target.value } : s))}
                          placeholder="0.00"
                          className="w-28 px-3 py-2 border border-gray-300 rounded-lg text-sm bg-card text-right tabular-nums focus:ring-2 focus:ring-boom-600 focus:border-transparent"
                        />
                        {artistSplits.length > 1 && (
                          <button
                            type="button"
                            onClick={() => setArtistSplits(prev => prev.filter((_, i) => i !== idx))}
                            className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  {/* Footer: add row (pre-filled with the remaining amount) + balance bar */}
                  <div className={`px-4 py-2.5 border-t flex items-center justify-between ${
                    balanced ? 'bg-emerald-50 border-emerald-100' : 'bg-amber-50/70 border-amber-100'
                  }`}>
                    <button
                      type="button"
                      onClick={() => setArtistSplits(prev => {
                        const sum = prev.reduce((s, sp) => s + parseFloat(sp.amount || 0), 0)
                        const rem = total > sum ? (total - sum).toFixed(2) : ''
                        return [...prev, { artist: '', song: '', amount: rem }]
                      })}
                      className="flex items-center gap-1 text-xs font-bold text-boom-700 hover:text-boom-800 transition-colors"
                    >
                      <Plus size={13} /> Add artist
                    </button>
                    <span className={`text-xs font-bold tabular-nums ${balanced ? 'text-emerald-700' : 'text-amber-700'}`}>
                      {balanced
                        ? <>✓ Split total matches invoice (${splitSum.toLocaleString('en-US', { minimumFractionDigits: 2 })})</>
                        : <>
                            Split ${splitSum.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                            {total > 0 && <> of ${total.toLocaleString('en-US', { minimumFractionDigits: 2 })} — {remaining >= 0 ? 'remaining' : 'over by'} ${Math.abs(remaining).toLocaleString('en-US', { minimumFractionDigits: 2 })}</>}
                          </>}
                    </span>
                  </div>
                </div>
                )
              })()}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <textarea
                value={form.description}
                onChange={e => handleFormChange('description', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-boom-600 focus:border-transparent"
                rows="3"
              ></textarea>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
              <textarea
                value={form.notes}
                onChange={e => handleFormChange('notes', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-boom-600 focus:border-transparent"
                rows="2"
              ></textarea>
            </div>

            {/* Payment status */}
            <div data-tour="add-invoice-status" className="flex items-start gap-6 flex-wrap">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.payment_status === 'Paid'}
                  onChange={e => handleFormChange('payment_status', e.target.checked ? 'Paid' : 'Unpaid')}
                  className="rounded border-gray-300 text-green-600 focus:ring-green-500"
                />
                <span className="text-sm font-medium text-gray-700">Mark as Paid</span>
              </label>
              {form.payment_status === 'Paid' && (
                <>
                  <div className="flex items-center gap-2">
                    <label className="text-sm text-gray-500">Date Paid</label>
                    <input
                      type="date"
                      value={form.payment_date}
                      onChange={e => handleFormChange('payment_date', e.target.value)}
                      className="px-2 py-1 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-600 focus:border-transparent"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-sm text-gray-500">Ref #</label>
                    <input
                      type="text"
                      value={form.payment_ref}
                      onChange={e => handleFormChange('payment_ref', e.target.value)}
                      placeholder="Check #, wire ref, etc."
                      className="px-2 py-1 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-600 focus:border-transparent w-44"
                    />
                  </div>
                </>
              )}
            </div>

            {/* Urgency token — Rush = "expedite this", Hold = "pause this".
                Mutually exclusive. Gated on payment_status !== 'Paid' because
                the DB trigger clears both on Paid anyway; showing the
                selector for paid rows would be misleading. */}
            {form.payment_status !== 'Paid' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Urgency</label>
                <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden">
                  {[
                    { key: 'none', label: 'Normal', Icon: null },
                    { key: 'rush', label: 'Rush',   Icon: Zap },
                    { key: 'hold', label: 'Hold',   Icon: Pause },
                  ].map(opt => {
                    const active = form.urgency === opt.key
                    const activeStyle = opt.key === 'rush'
                      ? 'bg-amber-100 text-amber-800 ring-1 ring-inset ring-amber-300'
                      : opt.key === 'hold'
                        ? 'bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-300'
                        : 'bg-gray-100 text-gray-800 ring-1 ring-inset ring-gray-300'
                    return (
                      <button
                        key={opt.key}
                        type="button"
                        onClick={() => setForm(prev => ({
                          ...prev,
                          urgency: opt.key,
                          // Clear the reason when switching back to Normal so
                          // stale text doesn't get sent if the user re-picks
                          // rush/hold later.
                          urgency_reason: opt.key === 'none' ? '' : prev.urgency_reason,
                        }))}
                        className={`px-4 py-1.5 text-sm font-semibold border-r border-gray-300 last:border-r-0 inline-flex items-center gap-1.5 transition-colors ${
                          active ? activeStyle : 'bg-white text-gray-500 hover:bg-gray-50'
                        }`}
                      >
                        {opt.Icon && <opt.Icon size={13} fill={active ? 'currentColor' : 'none'} />}
                        {opt.label}
                      </button>
                    )
                  })}
                </div>
                {form.urgency !== 'none' && (
                  <div className="mt-2">
                    <textarea
                      value={form.urgency_reason}
                      onChange={e => handleFormChange('urgency_reason', e.target.value.slice(0, 500))}
                      placeholder={form.urgency === 'rush'
                        ? 'Why is this a rush? (optional) — e.g. Vendor leaving for tour Friday'
                        : 'Why on hold? (optional) — e.g. Waiting on artist confirmation of the line-item breakdown'}
                      rows={2}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-boom-600 focus:border-transparent resize-y"
                    />
                    <div className="text-[10px] text-gray-400 text-right mt-0.5">
                      {form.urgency_reason.length}/500
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="flex gap-6">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.cobrand}
                  onChange={e => {
                    handleFormChange('cobrand', e.target.checked)
                    // Cobrand spend is Marketing by definition — the server
                    // enforces it too; setting it here keeps the form honest.
                    if (e.target.checked) handleFormChange('category', 'Marketing')
                  }}
                  className="rounded border-gray-300"
                />
                <span className="text-sm text-gray-700">Cobrand</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.is_reimbursement}
                  onChange={e => handleFormChange('is_reimbursement', e.target.checked)}
                  className="rounded border-gray-300"
                />
                <span className="text-sm text-gray-700">Is Reimbursement</span>
              </label>
            </div>
          </div>

          {/* Submit button */}
          <button data-tour="add-invoice-submit"
            type="submit"
            disabled={saving}
            className="w-full px-6 py-3 bg-boom-600 text-white rounded-lg hover:bg-boom-700 disabled:opacity-50 font-medium flex items-center justify-center gap-2"
          >
            {saving && <Loader className="w-4 h-4 animate-spin" />}
            {saving ? 'Saving...' : (isAdminLevel ? 'Review & Save Invoice' : 'Save Invoice')}
          </button>
        </form>
      </div>

      {/* ── The review ─────────────────────────────────────────────────────
          The same deck chrome, the same questions and the same document panel
          the Approvals page uses — because this invoice files as APPROVED the
          moment it is saved, and "approved" has to mean the same thing whichever
          door it came through.

          One card, so it opens at "1 of 1" and Cancel goes back to the form with
          everything still typed. Nothing has been written at this point: the
          create happens when the checklist is complete. */}
      {reviewOpen && (
        <ReviewDeck
          index={0}
          total={1}
          label={form.payee || 'New invoice'}
          onClose={() => { if (!saving) setReviewOpen(false) }}
          closeLabel="Cancel"
          z={90}
          hint="P preview · Esc close"
          aside={previewOn ? (
            <InlineFilePreview
              url={localDocUrl}
              filename={file?.name}
              label="Invoice"
              meta={form.payee}
              emptyText="No invoice file was attached — the review is against what you typed." />
          ) : null}
        >
          {() => (
            <div className="bg-card rounded-2xl shadow-2xl overflow-hidden">
              <div className="px-5 py-3.5 border-b border-rule">
                <div className="flex items-baseline justify-between gap-3">
                  <div className="text-[15px] font-black text-ink truncate">{form.payee || 'New invoice'}</div>
                  <div className="text-[15px] font-black text-ink tabular-nums shrink-0">
                    {new Intl.NumberFormat('en-US', { style: 'currency', currency: form.currency || 'USD' })
                      .format(Number(form.amount) || 0)}
                  </div>
                </div>
                <div className="text-[11px] text-gray-400 mt-0.5">
                  {form.invoice_number ? `inv ${form.invoice_number} · ` : ''}
                  entered by hand
                  {file ? '' : ' · no document attached'}
                  {' · files as approved'}
                </div>
              </div>

              <div className="px-5 py-3">
                <ApprovalChecklistFields
                  values={{
                    artist: form.artist,
                    song: form.song,
                    amount: form.amount,
                    // Cobrand forces Marketing, exactly as the server will.
                    category: reviewChecks.cobrand === true ? 'Marketing' : form.category,
                  }}
                  checks={reviewChecks}
                  onCheck={(k, v) => setReviewChecks((p) => ({ ...p, [k]: v }))}
                  onCobrand={(v) => setReviewChecks((p) => answerCobrand(p, v))}
                  // An edit here is a form edit — there is no row to PUT to yet.
                  // It writes through to the field above, so correcting it in the
                  // review corrects the invoice that gets created.
                  onFieldChange={(field, value) => {
                    handleFormChange(field, value)
                    setReviewChecks((p) => { const n = { ...p }; delete n[field]; return n })
                  }}
                  categories={CATEGORIES}
                  context={{
                    is_bulk_deal: form.is_bulk_deal,
                    bulk_deal_quantity: form.bulk_deal_quantity,
                    bulk_deal_unit: form.bulk_deal_unit,
                    cobrand: form.cobrand,
                  }}
                  disabled={saving}
                  fieldKey="add" />
              </div>

              <div className="px-5 pb-3">
                <SocialHandlesEditor
                  rows={socialRows}
                  onChange={setSocialRows}
                  disabled={saving}
                  currency={form.currency}
                  listId="add-invoice-social-platforms" />
              </div>

              {error && <div className="px-5 pb-2"><p className="text-[11px] text-rose-600">{error}</p></div>}

              <div className="px-5 py-3 border-t border-rule flex items-center gap-2">
                <button type="button" onClick={() => setReviewOpen(false)} disabled={saving}
                  className="px-3 py-2 rounded-lg text-[12px] font-bold text-gray-500 border border-rule hover:text-ink hover:border-gray-300 disabled:opacity-40">
                  Back to the form
                </button>
                <button type="button" onClick={togglePreview}
                  className="px-3 py-2 rounded-lg text-[12px] font-bold text-gray-500 border border-rule hover:text-ink hover:border-gray-300 inline-flex items-center gap-1">
                  <Receipt size={13} /> {previewOn ? 'Hide' : 'Show'}
                </button>
                <button
                  type="button"
                  onClick={() => submitInvoice({ checklist: checklistPayload(reviewChecks) })}
                  disabled={!checklistComplete(reviewChecks) || saving}
                  title={checklistComplete(reviewChecks)
                    ? 'File this invoice with the checklist answered'
                    : 'Every item has to be answered first'}
                  className="ml-auto px-4 py-2 rounded-lg text-[13px] font-bold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5">
                  {saving ? 'Saving…' : <><CheckCircle className="w-3.5 h-3.5" /> Save invoice</>}
                </button>
              </div>
              {!checklistComplete(reviewChecks) && (
                <div className="px-5 pb-3 -mt-1">
                  <p className="text-[11px] text-gray-400">
                    {checklistOutstanding(reviewChecks).join(' · ')} still to answer
                  </p>
                </div>
              )}
            </div>
          )}
        </ReviewDeck>
      )}
    </div>
  )
}
