// Shared helpers used across every NDA template. Kept separate so
// templates don't have to duplicate this logic and the CreateNDA page
// can import a single set of utilities regardless of which template
// is active.

// Market Street defaults — pre-fill the Owner side so most NDAs only
// require the recipient's info + an effective date. Same values that
// used to live at the top of CreateNDA.jsx.
// Filled from Settings › Label at runtime (applyLabelDefaults, called by
// CreateNDA when the label loads). Blank until then — never a placeholder
// that could print on a real NDA.
export const BOOM_DEFAULTS = {
  owner_name: 'Market Street',
  owner_address: '',
  signatory_name: '',
  signatory_title: '',
}
export function applyLabelDefaults(l) {
  if (!l) return BOOM_DEFAULTS
  BOOM_DEFAULTS.owner_name = l.legal_name || l.display_name || 'Market Street'
  BOOM_DEFAULTS.owner_address = [l.address_line1, l.address_line2].filter(Boolean).join(', ')
  BOOM_DEFAULTS.signatory_name = l.signatory_name || ''
  BOOM_DEFAULTS.signatory_title = l.signatory_title || ''
  return BOOM_DEFAULTS
}

// Roman numerals for section headers. Sections are renumbered
// sequentially based on which optional sections are included, so
// headers always run I, II, III… without gaps when something is
// omitted. Every template that uses numbered sections can pull these.
export const ROMAN = [
  'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII',
  'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI',
]

// Parse YYYY-MM-DD as a local date so timezone doesn't shift it a day.
export function formatEffectiveDate(s) {
  if (!s) return ''
  const [y, m, d] = String(s).split('-').map(Number)
  if (!y || !m || !d) return s
  const dt = new Date(y, m - 1, d)
  return dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

// Escape a string for use inside a RegExp. Used by the dirty-mode body
// diff to swap old field values in the body text with new ones.
export function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Heading detection for the editable body. Returns:
//   2 — h1: centered title, larger font (the document title)
//   1 — h2: bold heading (section / subsection headers)
//   0 — body paragraph
// Heuristics intentionally biased toward false-negatives: a paragraph
// that fails the test renders as body text, which is safe. The opposite
// (false-positive) would bold something users wrote as a sentence.
// Every template's PDF renderer + on-screen preview uses this same
// pass, so a new template just needs its section headers to fit the
// same shape (Roman numeral or single-letter subsection, or short
// all-caps title without a period).
export function getHeadingLevel(rawText) {
  const text = (rawText || '').trim()
  if (!text) return 0
  // h1: short, no period, all-uppercase title (e.g., NON-DISCLOSURE AGREEMENT).
  if (text.length <= 80 && /^[A-Z][A-Z0-9 .,&\-/']{4,}$/.test(text) && !text.includes('.')) return 2
  // h2: Roman numeral header (I. / II. / XIV.) or single-letter subsection
  // (A. / B.) followed by a short title sentence. The dot-count guard keeps
  // a long body paragraph that happens to start with "I." from matching.
  const m = /^([IVXLCDM]{1,5}|[A-Z])\.\s+\S/.exec(text)
  if (m && text.length < 220 && (text.match(/\./g) || []).length <= 3) return 1
  return 0
}

// The shared base fields that every template gets on the form. Templates
// declare `extraFields` on top of these. Kept as an ordered list so the
// UI can render them in the right order without hard-coding paths in
// the CreateNDA render.
export const BASE_FIELDS = [
  { key: 'effective_date', label: 'Effective Date', type: 'date', required: true, group: 'timeline' },
  { key: 'owner_name',      label: 'Owner Name',      type: 'text', required: true,  group: 'owner' },
  { key: 'owner_address',   label: 'Owner Address',   type: 'text', required: false, group: 'owner' },
  { key: 'recipient_name',    label: 'Recipient Name',    type: 'text', required: true,  group: 'recipient' },
  { key: 'recipient_address', label: 'Recipient Address', type: 'text', required: false, group: 'recipient', placeholder: 'Street, city, state, zip' },
  { key: 'signatory_name',  label: 'Signatory Name',  type: 'text', required: false, group: 'signatory' },
  { key: 'signatory_title', label: 'Signatory Title', type: 'text', required: false, group: 'signatory' },
]

// Field keys that appear directly in the body text and should
// participate in the dirty-mode auto-sync (find-old, replace-with-new).
// Effective date is handled separately since it's date-formatted before
// substitution. Templates with extra body-participating fields should
// list them here on the template object.
export const BASE_BODY_FIELDS = [
  'owner_name', 'owner_address',
  'recipient_name', 'recipient_address',
  'signatory_name', 'signatory_title',
]

// Signature block renderer — shared across every template. Returns a
// structured payload (party line + list of lines) that NDAPreview
// (on-page) and the jsPDF download path both consume.
//
// The recipient side inspects two optional extras:
//   recipient_signatory_name  — the individual signing on behalf of
//     the recipient entity. Falls back to recipient_name so a template
//     without corporate signers (default standard NDA) still reads
//     naturally: "Name: <the recipient>".
//   recipient_signatory_title — role of that individual. Omitted from
//     the block when blank so the standard NDA doesn't render an
//     empty Title: line for individual recipients.
//
// Templates that need something more exotic (e.g. two signers per
// side, a witness block, etc.) can override this by exporting their
// own `renderSignature(form)` and CreateNDA will prefer that.
export function defaultRenderSignature(form) {
  const ownerName = form.owner_name || ''
  const signatoryName = form.signatory_name || ''
  const signatoryTitle = form.signatory_title || ''
  const recipientName = form.recipient_name || ''
  const recipientSignName  = form.recipient_signatory_name  || ''
  const recipientSignTitle = form.recipient_signatory_title || ''
  const nameOnRecipientLine = recipientSignName || recipientName
  return {
    owner: {
      party: `OWNER: ${ownerName}`,
      lines: [
        'By: ____________________________',
        `Name: ${signatoryName}`,
        `Title: ${signatoryTitle}`,
        'Date: ____________________________',
      ],
    },
    recipient: {
      party: `RECIPIENT: ${recipientName}`,
      lines: [
        'By: ____________________________',
        `Name: ${nameOnRecipientLine}`,
        ...(recipientSignTitle ? [`Title: ${recipientSignTitle}`] : []),
        'Date: ____________________________',
      ],
    },
  }
}
