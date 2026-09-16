// Canonical lists used across the bookkeeping pages and forms. Mirrored
// in server/lib/constants.js — keep them in sync until Phase 1.4 lifts
// shared schemas across the client/server boundary.
//
// Filter dropdowns that need an "All" / empty sentinel should reconstruct
// it page-locally, e.g.:
//   const FILTER_REPS       = ['All reps', ...BOOM_REPS]
//   const FILTER_CATEGORIES = ['All categories', ...CATEGORIES]
// The canonical lists do NOT include sentinels.

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'MXN', 'JPY', 'BRL', 'CHF', 'SEK', 'NOK', 'DKK']

// Same set with human-friendly labels for selects that need them
// (e.g. the public vendor-submit form). Order matches CURRENCIES' priority
// (USD/EUR/GBP first, then the rest).
export const CURRENCY_OPTIONS = [
  { value: 'USD', label: 'USD — US Dollar' },
  { value: 'EUR', label: 'EUR — Euro' },
  { value: 'GBP', label: 'GBP — British Pound' },
  { value: 'CAD', label: 'CAD — Canadian Dollar' },
  { value: 'AUD', label: 'AUD — Australian Dollar' },
  { value: 'CHF', label: 'CHF — Swiss Franc' },
  { value: 'SEK', label: 'SEK — Swedish Krona' },
  { value: 'NOK', label: 'NOK — Norwegian Krone' },
  { value: 'DKK', label: 'DKK — Danish Krone' },
  { value: 'JPY', label: 'JPY — Japanese Yen' },
  { value: 'MXN', label: 'MXN — Mexican Peso' },
  { value: 'BRL', label: 'BRL — Brazilian Real' },
]

export const BOOM_REPS = ['John']

export const CATEGORIES = [
  'Recording', 'Mixing & Mastering', 'Music Video', 'Marketing', 'PR', 'Radio',
  'Sync/Licensing', 'Distribution', 'Design', 'Production', 'Legal',
  'Services', 'Merch', 'Tour/Live', 'Advertisements', 'Travel', 'Meals & Entertainment', 'Software / Subscriptions', 'Utilities', 'Rent', 'Bank Fees', 'Royalties', 'Salary', 'Reimbursements', 'Advance', 'Other',
]

// Income (credit) counterpart to CATEGORIES. Bank credits book as
// artist_income rows typed from this list; the Reports P&L income section
// and the statements deck both read it.
export const INCOME_CATEGORIES = [
  'Streaming / Distribution', 'Sync Licensing', 'Publishing', 'Merch',
  'Performance', 'Rent', 'Drawdown Fund', 'Reimbursements', 'Refund', 'Other Income',
]

export const PAYMENT_METHODS = ['ACH', 'Check', 'Wire', 'Credit Card', 'PayPal', 'Cash']
export const SOCIAL_PLATFORMS = ['Instagram', 'TikTok', 'YouTube', 'Twitter / X', 'Facebook', 'Other']

// ── How the pickers group the vocabulary ─────────────────────────────────────
//
// John, 2026-08-24, on the approval checklist's category dropdown: "organize the
// categories better." It was already ordered — GET /api/categories ranks by real
// usage — but the ranking is GLOBAL while a picker is contextual, so on a
// vendor-invoice screen the top of the list read Marketing, Bank Fees,
// Advertisements, Meals & Entertainment, Travel, Software / Subscriptions. Those
// five after Marketing have been used on a vendor-submitted invoice ZERO times
// between them; they rank that high on 1,608 bank and card rows the approvals
// screen never sees. `Recording`, with 23 uses on that exact surface, sat ninth.
//
// Sections fix that without a second ordering rule: usage ranking still decides
// the order INSIDE a group, and the groups put the plausible answers near the top.
// It also stops related categories sitting screens apart — `Legal`,
// `True Legal` and `Artist Expense - Legal` were at ranks 30, 18 and 20.
//
// The client copy is the OFFLINE FALLBACK, mirroring the server seed —
// same arrangement as CATEGORIES itself.
//
// This is the SEED, not the source of truth. `bk_categories.ui_group` is, so a
// category created next month can be grouped without a deploy — same arrangement
// as `report_section`. Anything unseeded and anything new defaults to 'other',
// which is visible and honest rather than quietly wrong.
//
// Deliberately NOT `report_section`, which already exists: it has three values
// (operating / below_line / non_recurring) and answers "where on the P&L". Marketing,
// Bank Fees, Salary and Rent are all 'operating', so grouping by it would rebuild
// the undifferentiated 32-item blob this exists to break up. Orthogonal axes.
export // Wider than the live table on purpose: seven of these (Mixing & Mastering,
// Music Video, PR, Radio, Design, Production, Merch) were deactivated when the
// six redundant categories were merged, but they are still in the seed constant,
// still the client's offline fallback, and still stored on historical rows. A
// grouping that omitted them would drop them into OTHER for no reason.
const CATEGORY_GROUP_SEED = {
  expense: {
    campaign: ['Marketing', 'Advertisements', 'Sync/Licensing', 'Distribution',
      'Artist Expense - PR', 'True PR', 'Music Video', 'PR', 'Radio', 'Design'],
    record: ['Recording', 'Artist Expense - Recording', 'Services', 'Studio House',
      'Mixing & Mastering', 'Production'],
    artist: ['Advance', 'Artist Expense - Other', 'Tour/Live', 'Artist Expense - Legal',
      'Royalties', 'Royalty Service Expense'],
    people: ['Salary', 'Salary (Felipe)', 'Partner - Felipe', 'Partner - Tyler', 'Bookkeeper'],
    label: ['Software / Subscriptions', 'Travel', 'Meals & Entertainment', 'Bank Fees',
      'Credit Card', 'Rent', 'Utilities', 'Legal', 'True Legal'],
    other: ['Other', 'Reimbursements', 'Merch'],
  },
  income: {
    earnings: ['Streaming / Distribution', 'Publishing', 'Sync Licensing', 'Performance',
      'Merch', 'Catalog Sales'],
    recoveries: ['Advance Refund', 'Marketing Reimbursement', 'Reimbursements', 'Refund'],
    other: ['Rent', 'Drawdown Fund', 'Other Income'],
  },
};

// Display label and order for each group key. The ORDER of this array is the
// order the sections render in.
export const CATEGORY_GROUPS = {
  expense: [
    ['campaign', 'Campaign & promotion'],
    ['record',   'Making the record'],
    ['artist',   'The artist'],
    ['people',   'People & partners'],
    ['label',    'Running the label'],
    ['other',    'Other'],
  ],
  income: [
    ['earnings',   'Earnings'],
    ['recoveries', 'Recoveries'],
    ['other',      'Other'],
  ],
};
