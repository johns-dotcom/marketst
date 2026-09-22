// Constants + pure helpers for the Releases page.
// Split out so the main file can import them without the module-level
// definitions cluttering the component body.

// The computed release status (server routes/releases.js releaseStatus): one pill per row.
export const RELEASE_STATUS_TONE = { Draft: 'bg-gray-100 text-gray-600 border-gray-200', Scheduled: 'bg-amber-50 text-amber-700 border-amber-200', Ingested: 'bg-blue-50 text-blue-700 border-blue-200', Released: 'bg-emerald-50 text-emerald-700 border-emerald-200', Archived: 'bg-gray-50 text-gray-400 border-gray-200' }

export const CHECKLIST_ITEMS = [
  { key: 'yt_video',        label: 'YT Video',        group: 'Content' },
  { key: 'content',         label: 'Content',          group: 'Content' },
  { key: 'marketing_plan',  label: 'Marketing Plan',   group: 'Content' },
  { key: 'official_thread', label: 'Official Thread',  group: 'Content' },
  { key: 'uploaded',        label: 'Uploaded',         group: 'Distribution' },
  { key: 'recoup_added',    label: 'Recoup Added',     group: 'Distribution' },
  { key: 'budget',          label: 'Budget',           group: 'Distribution' },
  { key: 'stem_pitch',      label: 'Stem Pitch',       group: 'Pitching' },
  { key: 's4a_pitch',       label: 'S4A Pitch',        group: 'Pitching' },
  { key: 'amazon_pitch',    label: 'Amazon Pitch',     group: 'Pitching' },
  { key: 'pandora',         label: 'Pandora',          group: 'Pitching' },
  { key: 'marquee',         label: 'Marquee',          group: 'Pitching' },
  { key: 'dsp_email',       label: 'DSP Email',        group: 'Pitching' },
  { key: 'musixmatch',      label: 'Musixmatch',       group: 'Pitching' },
]
export const CHECKLIST_GROUPS = ['Content', 'Distribution', 'Pitching']

export const GENRE_OPTIONS = ['All', 'Hip-Hop', 'EDM', 'Pop', 'Alt', 'R&B', 'Electronic', 'Hip Hop/Rap', 'Hip-Hop/Rap', 'Latin']
export const PRIORITY_OPTIONS = ['All', 'standard', 'priority', 'high priority']
export const TYPE_OPTIONS = ['All', 'single', 'EP', 'album']
export const UPCOMING_OPTIONS = ['All', 'Upcoming', 'Past']
export const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

export const DSP_STATUSES = ['Not Submitted', 'Submitted', 'Approved', 'Live', 'Rejected']
export const DSP_STATUS_STYLES = {
  'Not Submitted': 'bg-gray-100 text-gray-500',
  'Submitted':     'bg-blue-100 text-blue-700',
  'Approved':      'bg-amber-100 text-amber-700',
  'Live':          'bg-emerald-100 text-emerald-700',
  'Rejected':      'bg-red-100 text-red-700',
}

export const BUDGET_CATEGORIES = ['Music Video', 'Marketing', 'Artwork', 'Mixing/Mastering', 'Distribution', 'Promotion', 'Studio', 'Advance', 'Other']

// Initial form shape for the "Add Release" modal. Exported so AddReleaseModal
// can reset back to this blank state after a successful POST.
export const BLANK_RELEASE = {
  artist_name: '', project_name: '', release_date: '', release_type: '',
  genre: '', priority: 'standard', producer: '', featured_artists: '',
  upc: '', isrc: '', distributor_notes: '', notes: '',
  cover_art_status: 'Pending', spotify_uri: '', apple_music_link: '', presave_link: '',
}

export const TAB_IDS = ['checklist', 'metadata', 'dsp', 'budget', 'activity', 'comments', 'details']

// Parse a date string (YYYY-MM-DD or ISO) as local time, not UTC.
// `new Date("2026-03-15")` is UTC midnight → wrong day in US timezones.
export function parseLocalDate(dateStr) {
  if (!dateStr) return null
  const s = dateStr.split('T')[0]
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function daysUntil(dateStr) {
  const d = Math.ceil((parseLocalDate(dateStr) - new Date()) / 86400000)
  if (d < 0)   return { label: `${Math.abs(d)}d ago`, cls: 'text-gray-400' }
  if (d === 0) return { label: 'Today',               cls: 'text-emerald-500' }
  if (d <= 14) return { label: `${d}d away`,          cls: 'text-orange-500' }
  return         { label: `${d}d away`,               cls: 'text-gray-400' }
}

export function getCompletionPercentage(release) {
  const completed = CHECKLIST_ITEMS.filter(item => release[item.key]).length
  return Math.round((completed / CHECKLIST_ITEMS.length) * 100)
}

export function getPriorityBadge(p) {
  if (p === 'high priority') return 'badge badge-red'
  if (p === 'priority')      return 'badge badge-yellow'
  return 'badge badge-gray'
}
