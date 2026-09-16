import { useMemo, useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { ArrowLeft, Printer, RefreshCw } from 'lucide-react'
import api from '../api'

// Full catalogue of pages — mirrors ALL_PAGES in Settings.jsx but adds per-page
// guidance (intro + 3–5 actionable bullets). Order here is the render order.
const MANUAL_PAGES = [
  { path: '/',             group: 'General',  title: 'Dashboard',
    intro: 'Your home screen. Stats, notifications, activity feed, and quick links.',
    tasks: [
      'Scan upcoming releases and overdue tasks at a glance',
      'Click a notification to jump to its source item',
      'Hit "r" to refresh the stats without a full page reload',
    ] },
  { path: '/my-work',      group: 'General',  title: 'My Work',
    intro: 'Your command center — tasks plus everything waiting on you across the app.',
    tasks: [
      '"To Do Today" leads with overdue (with days-late stamps), due-today, and in-progress items — snooze, start, or reschedule from the row',
      'Quick-add understands shorthand: "!high" sets priority, "#Finance" sets category, and words like "tomorrow" or "friday" set the due date',
      'The "Waiting on you" rail collects review assignments, unread @mentions, the approvals queue, and the statement-cutoff countdown (a horizontal strip on phones)',
      'The Done-this-week digest shows what you closed out',
    ] },

  { path: '/artists',      group: 'Artists',  title: 'Artist Roster',
    intro: 'Every artist on the label, with genre, release count, and contract status.',
    tasks: [
      'Search by name, genre, or city',
      'Click an artist to open their profile + release history',
      'Use the filter pills to segment by genre or signing status',
    ] },
  { path: '/deals',        group: 'Artists',  title: 'Deal Pipeline',
    intro: 'A&R signing funnel: Scouting → In talks → Signed / Passed.',
    tasks: [
      'Drag-drop cards between stages to update a deal',
      'Press "n" to add a new deal',
      'Click a card for full notes, contacts, and links',
    ] },

  { path: '/releases',     group: 'Releases', title: 'Release Tracker',
    intro: 'Upcoming and past releases with per-release checklists, metadata, DSP links, and budgets.',
    tasks: [
      'Filter by year, month, genre, priority, format',
      'Click a release to expand its 14-item checklist',
      'Tab 1–7 jumps between Checklist / Metadata / DSP / Budget / Activity / Comments / Details',
      'Press "v" to toggle list and calendar views',
    ] },
  { path: '/catalog',      group: 'Releases', title: 'Catalog',
    intro: 'Streaming performance across the entire catalog, grouped by artist.',
    tasks: [
      'Press "s" to sync missing artwork from Spotify',
      'Number keys 1–6 set the date range (All time, This year, 6/12/24 months, Custom)',
      'Sort by streams, revenue, or release date',
    ] },

  { path: '/duplicates',   group: 'Releases', title: 'Flags & Duplicates',
    intro: 'Data-quality sweep — duplicate detection and consistency flags across releases, artists, vendors, invoices, and the ledger.',
    tasks: [
      'Duplicate releases (name / UPC / ISRC / Spotify URI), artists, vendors, and invoices (4 severity tiers) with one-click merge',
      'Release issues: missing genre, UPC, ISRC, or Spotify links',
      'Ledger artist flags: unknown names, likely typos, casing variants, multi-artist fields, missing artist/song/socials, artist↔song mismatches',
      'Dismiss individual flags or whole groups (audited, restorable)',
      'Apply an artist rename across the whole app — the mapping is remembered so future imports auto-collapse',
    ] },
  { path: '/import/master-sheet', group: 'Releases', title: 'Master Sheet Import',
    intro: 'Import the label master sheet — new releases and artists diffed against the app before anything is written.',
    tasks: [
      'Header-row detection handles tabs with different column layouts',
      'Review the diff (new artists / new releases / changes) before committing',
      'Date-shaped artist names are rejected as parse errors, not imported',
    ] },
  { path: '/contracts',         group: 'Contracts', title: 'Contracts',
    intro: 'Every signed contract with artist, advance, royalty split, and expiration.',
    tasks: [
      'Search by artist or contract type',
      'Click for full terms, attached PDF, and amendments',
      'Use the Generate button on an artist to draft a new contract with AI',
    ] },
  { path: '/pending-contracts', group: 'Contracts', title: 'Pending Contracts',
    intro: 'Contracts drafted but not yet signed. Track the back-and-forth.',
    tasks: [
      'Upload the counter-signed PDF to move a contract to Active',
      'Add comments to capture negotiation state',
      'See who owns the next step',
    ] },
  { path: '/renewals',          group: 'Contracts', title: 'Renewals',
    intro: 'Contracts expiring soon, colour-coded by urgency.',
    tasks: [
      'Red = expiring within 30 days',
      'Filter by artist or contract type',
      'Jump straight to the contract to start a renewal',
    ] },
  { path: '/contracts/create',  group: 'Contracts', title: 'Create Contract',
    intro: 'Draft a new contract with AI-assisted clauses.',
    tasks: [
      'Pick an artist, type, and term — AI fills in standard clauses',
      'Edit any paragraph inline before generating the PDF',
      'Save as Pending to track it through to signature',
    ] },

  { path: '/create-nda',  group: 'Contracts', title: 'Create NDA',
    intro: 'Generate NDAs from templates — standard, mutual, and corporate-recipient variants.',
    tasks: [
      'Pick a template; optional clauses toggle on/off and the body rebuilds',
      'Edit the body freely — section headers render bold; the signature block is added automatically',
      'Missing mandatory sections are flagged before download',
      'Download as PDF or Word (.docx) — identical formatting, ready for redlining',
    ] },
  { path: '/create-label-waiver', group: 'Contracts', title: 'Create Label Waiver',
    intro: 'Issue and track label waivers signed by artists.',
    tasks: [
      'Fill the waiver fields and save — the record is kept per artist',
      'Download the generated document for signature',
    ] },
  { path: '/create-artist-clearance', group: 'Contracts', title: 'Artist Clearance',
    intro: 'Clearance records per artist — who cleared what, when.',
    tasks: [
      'Create a clearance against an artist with the relevant details',
      'Records are tracked per artist and visible on their profile',
    ] },
  { path: '/bk/ledger',    group: 'Finance',  title: 'Ledger',
    intro: 'The master expense ledger with filters, columns, and inline edits.',
    tasks: [
      'Frozen columns for Date / Payee / Artist / Amount / Currency — always visible',
      'Press "c" to toggle which columns are shown, "z" to undo, "x" to export Excel',
      'Type comma-separated songs ("Song A, Song B") to auto-split an entry',
      'Split children carry their own Recoup / UFR / Campaign / Cobrand / Bulk toggles — half an invoice can be recoupable while the other half isn\'t',
      'Rows staged in Recoupment Planning show a link straight to the planning page',
      'On phones the ledger renders as cards — tap a card for details, notes editing, paid cycling, and file viewing',
      'Export menu: Excel / CSV of the half you\'re on, a ZIP of every approved invoice, a ZIP of every vendor W9, and "Files ZIP" — invoices, proofs, W9s and receipts narrowed by the artist, category and search filters',
    ] },
  { path: '/bk/approvals', group: 'Finance',  title: 'Approvals',
    intro: 'Review vendor-submitted invoices before they land on the ledger. Bookkeeping admins (incl. Approvers).',
    tasks: [
      'j / k move between entries, "a" approves, "r" rejects, Shift+A bulk approves',
      'AI invoice scan flags discrepancies between the form and the PDF — Edit re-scans automatically, or press "Run scan" on a row that never scanned',
      'Flag an entry for review or mark it Rush so it surfaces on the Payment Dashboard',
      'Click Aliases to link a vendor\'s alternate names (so their W9 auto-applies)',
      'Tick "Notify vendor" to send an approval / rejection email',
      'Admins: the Archive link holds rejected and deleted invoices with who/when attribution and a Restore button',
    ] },
  { path: '/bk/payments',  group: 'Finance',  title: 'Payment Dashboard',
    intro: 'Track invoices through to payment. Shows unpaid items plus anything paid in the last 14 days — older payments live on the Ledger.',
    tasks: [
      'Quick filters: Unpaid / Due Soon / Overdue / Rush / Hold / Paid',
      'Rush flags an invoice as urgent (with a reason); Hold pauses it out of the Overdue and Due Soon buckets',
      'Select rows and click "Send for Approval" to email Felipe or Jesse an Excel summary + invoice PDFs',
      'Upload a proof of payment — AI extracts the date and reference and marks the invoice paid',
      'Send Confirmations walks vendor-by-vendor through payment-confirmation emails; the vendor\'s saved extra emails are CC\'d automatically',
      'On phones the dashboard renders as cards with a detail sheet per payment and a sticky bulk bar',
    ] },
  { path: '/recoupments',  group: 'Finance',  title: 'Recoupments',
    intro: 'Every recoupable expense grouped by artist. Track what\'s been uploaded for recoupment against monthly statements.',
    tasks: [
      'Statement tabs slice items into monthly windows — the cutoff is the 20th of each month',
      'Priority (High / Medium / Low) is a tag with its own subtabs; sorting stays by pending-upload amount',
      'Mark an artist or release "Ready for planning" (folder icon) — it becomes a filter and shows on Planning',
      'Tag prior-year spend as "2025 Expenses" — it gets its own subpage with artist key cards',
      'Toggle UFR per line item, edit socials (with a running $ total), and leave page or per-artist notes',
    ] },

  { path: '/recoupments/planning', group: 'Finance', title: 'Recoupment Planning',
    intro: 'Build the batch you\'ll actually upload for recoupment — staged separately from the live Recoupments view.',
    tasks: [
      'Add items from Recoupments or the Ledger; group the plan by song or by label',
      'Select-all checkboxes per song / category, with $ totals on the selection bar',
      'Commit the selection to mass-mark UFR in one click',
      '"Save for later" tags an artist into a deferred section at the bottom (excluded from commits)',
      'Flags and notes per card keep planning context with the batch; paid / unpaid status shows on every item',
    ] },
  { path: '/artist-campaigns', group: 'Marketing', title: 'Artist Campaigns',
    intro: 'Campaign spend by artist and song — the collaborative hub for reviewing, splitting, and classifying marketing expenses without touching the Ledger.',
    tasks: [
      'Artist cards (sorted by priority, then spend) drill into songs, then individual expenses',
      'Row actions: split across artists/songs, edit artist / song / category, cobrand, bulk deal, mark paid, attach an invoice to an added expense, or mark not-a-campaign',
      'Flag any expense for review and assign teammates — assignments land in their My Work rail and the Needs Review inbox',
      'Every page and subpage has its own chat (bottom-right button) with @mentions; comment threads sit under the notes',
      'Mark a release or artist "Ready for planning" to hand it to Recoupment Planning',
      'Add expenses here and they auto-approve, auto-mark paid, and auto-tag recoupable',
    ] },
  { path: '/bk/bulk-deals',group: 'Marketing',title: 'Bulk Deals',
    intro: 'Recurring or bulk-billed deals (e.g. monthly retainer, multi-song packages).',
    tasks: [
      'Track deliverables per deal with a checklist',
      'Stalled deals (no progress in a while) are detected and surfaced in notifications',
      'Archive a deal to the Completed section when done',
      'Split amounts across multiple artists with the same artist-breakdown UI as regular invoices',
      'The Socials section tracks creator handles and per-deliverable amounts',
    ] },

  { path: '/bk/add',           group: 'Finance — Invoicing', title: 'Add Invoice',
    intro: 'Manually enter a vendor invoice (for expenses that didn\'t come through /submit).',
    tasks: [
      'AI parse button reads the invoice PDF and pre-fills the form',
      'Drop the invoice file and proof of payment together in one go',
      'Defaults to Net 30 payment terms',
    ] },
  { path: '/bk/reimburse',     group: 'Finance — Invoicing', title: 'Add Reimbursement',
    intro: 'Log an expense a team member paid out of pocket.',
    tasks: [
      'Attach the original receipt',
      'Select the team member being reimbursed',
      'Automatically tagged as Reimbursement on the ledger',
    ] },
  { path: '/bk/bulk-upload',   group: 'Finance — Invoicing', title: 'Bulk Upload',
    intro: 'Batch-upload a stack of invoices and proofs; AI matches them up.',
    tasks: [
      'Drop multiple PDFs into the Invoices and Proofs drop zones',
      'AI parses each, matches proofs to invoices by payee + amount',
      'Review and manually re-match on the confirmation table before submit',
    ] },
  { path: '/bk/bulk-reupload', group: 'Finance — Invoicing', title: 'Bulk Re-upload',
    intro: 'Repair page — NOT for new invoices. Lists expenses whose stored files are broken/truncated so the originals can be re-uploaded.',
    tasks: [
      'Use when an invoice / W9 / proof preview fails to load',
      'Re-upload the original file and it lands in current storage',
      'For normal batch intake use Bulk Upload, not this page',
    ] },
  { path: '/create-invoice',   group: 'Finance — Invoicing', title: 'Create Invoice',
    intro: 'Generate an invoice FROM Market Street to an external party.',
    tasks: [
      'Add line items with Cmd+Shift+L',
      'Cmd+Enter to save, Cmd+P to print / export PDF',
      'Select an existing client or enter a new one',
    ] },

  { path: '/bk/vendors',       group: 'Finance — Documents', title: 'Vendors',
    intro: 'One row per company — invoices AND bank activity together (invoiced, bank spend, open items, W9, learned category). Replaces the separate Bank Vendors page.',
    tasks: [
      'Sorted by relationship $ (invoiced + open bank); every column sortable; search covers names, aliases, emails, and bank payees',
      'Click a vendor for full invoice history and expandable split groups',
      'Hover a row for quick actions: review its bank transactions, or merge it into another vendor',
      '"Unlinked bank payees" at the bottom is a finishable queue — Link each to a vendor or review its transactions',
      'The Duplicates tab is the detection queue: keyboard review (arrows/S/C/A/D), one-click bulk merge for high-confidence pairs, exact variants auto-merge silently',
    ] },
  { path: '/bk/invoices',      group: 'Finance — Documents', title: 'Invoices',
    intro: 'All invoice documents indexed for quick lookup.',
    tasks: [
      'Search by invoice number, vendor, or artist',
      'Normalized invoice-number matching catches #003 vs 003 vs INV-003',
      'Click to preview inline without downloading',
    ] },

  { path: '/financials',       group: 'Finance — Analytics', title: 'Financials',
    intro: 'Profit & loss by artist, by month, attributed on payment date.',
    tasks: [
      'Date basis is COALESCE(payment_date, invoice_date) — expenses count when paid',
      'Drill into a month to see the underlying ledger rows',
      'Compare artists side-by-side',
    ] },
  { path: '/bk/ledger-matching', group: 'Finance — Analytics', title: 'Bookkeeper Reconcile',
    intro: 'Reconcile the ledger against the external bookkeeper\'s export. Not the bank matcher — that\'s Bank Matching. This page compares the accountant\'s spreadsheet; that one compares the bank.',
    tasks: [
      'Fuzzy vendor matching (suffixes, parentheticals, reordered names) with confidence chips',
      'Mismatch buckets: amount, paid status, paid date, missing on either side, no invoice #',
      'Export any bucket to CSV / Excel for the bookkeeper',
    ] },
  { path: '/reports',          group: 'Finance — Analytics', title: 'Reports (P&L / Balance Sheet)',
    intro: 'Live financial statements: a cash-basis P&L and a balance sheet with bank-verified cash.',
    tasks: [
      'P&L: pick a date range — income (from income entries + booked statement credits) and Paid expenses by category, monthly columns, net income row',
      'Balance Sheet: pick an as-of date — Cash from the latest statement ending balances, A/R from unpaid outbound invoices, A/P from approved unpaid bills, Equity as the balancing figure',
      'Export either report as a styled Excel workbook',
      'Book statement credits as income (Money in chip on Statements) to keep the revenue side bank-verified',
    ] },
  { path: '/bk/statements',    group: 'Finance — Analytics', title: 'Statements',
    intro: 'The statement FILES: upload Bank of America / PayPal statements (CSV or PDF) and keep track of which months you actually have. Admins only. The reconciling itself happens on Bank Matching.',
    tasks: [
      'Upload the transaction CSV (exact) or the monthly PDF (AI-parsed) — parsing and matching run automatically on upload',
      'Month library: see coverage at a glance and which months are missing a statement',
      'Statement flags: parse problems, duplicate uploads, balances that don\'t reconcile',
      'Open the original file for any statement you\'re working against',
    ] },
  { path: '/bk/bank-matching', group: 'Finance — Analytics', title: 'Banking — For review',
    intro: 'Tie every line on the bank statements to the ledger. The bank knows money moved; only the invoice knows who it was for and why — this is where the two are connected. It matters more than it sounds: the P&L is built from the bank, so an unexplained line is already in your totals as spend nobody can account for.',
    tasks: [
      'Every open line has exactly three honest answers: it\'s this invoice (match), there\'s no invoice for it (book it), or it isn\'t really spending (set it aside — an internal transfer, a PayPal funding leg)',
      'When several invoices could be the one, the cards highlight only the fields that DIFFER between them and mute what they share — same vendor and amount is common, so artist, song and entry time are usually what tells them apart',
      'A red warning appears when candidates match on vendor, amount and confidence: marking the wrong one paid is silent, and nothing downstream contradicts it',
      'Actions are grouped by consequence — flagging and searching are free to undo; booking and setting aside move a reported total',
      'This is one tab of Banking. The header above the tabs picks the statement and holds the tie-out, and it scopes all four tabs — choose the month once and Categorized, Statements and Rules follow you',
      '"N left to review" in that header is the whole to-do, and the statement picker counts the same way — a bank line with no ledger entry, or with one the app invented and no invoice behind it',
      'Three tabs across the table, and they add up to the debits exactly: For review (nothing decided, plus booked-with-no-invoice), Categorized (matched, or booked and not owed a document), Excluded (set aside). Refine, next to the search box, holds the narrower worklists — Likely, Suggested, Needs invoice, Flagged, Reversals',
      'The bar under the title is one whole: filled dark is invoice-backed, grey is booked but with nothing billed, the rest is untouched. Closing the grey gap is the job',
      'The Category column doubles as the lens — click "artist" in its header to re-group by artist, and click any value to filter to it',
      'Review runs the queue one card at a time',
      'A payee opens its vendor page in a new tab — invoices, bank lines, the attach picker — so a side-trip to check one vendor does not cost your place in the queue',
      '⋯ also holds the statement file, Upload rules, artist attribution on Reports, what the rules decided on your behalf, and Reset matching',
      'Confirm payments: matched-but-unpaid ledger entries get marked Paid in bulk with the bank\'s real date and reference. Split families match on their combined total, and confirming marks the whole family Paid',
    ] },
  { path: '/budget',           group: 'Finance — Analytics', title: 'Recording Budgets',
    intro: 'Structured recording budgets with a draft → approved → locked lifecycle.',
    tasks: [
      'Sections: Producers, Studio, Mixing/Mastering, Musicians, Travel, Other — line items each',
      'Approve to lock the amounts (line items can still be added with a note); Lock to freeze entirely',
      'Costs-to-date pulls matching ledger spend against each line',
      'Every approve / lock is attributed (who, when)',
    ] },
  { path: '/import',           group: 'Finance — Analytics', title: 'QB Import',
    intro: 'Import a QuickBooks CSV to back-populate the ledger.',
    tasks: [
      'Map QB columns to ledger fields on the preview screen',
      'Duplicate detection uses invoice number + email',
      'Successfully imported rows go straight to status = approved',
    ] },

  { path: '/team',     group: 'Team', title: 'Team',
    intro: 'Team members and their assigned tasks.',
    tasks: [
      'Press "n" to create and assign a task',
      'Overdue tasks show a red pill',
      'Click a team member for their full task list and release assignments',
    ] },
  { path: '/calendar', group: 'Team', title: 'Calendar',
    intro: 'Unified calendar — releases, task due dates, contract expirations.',
    tasks: [
      'Arrow keys / "t" navigate months',
      'Press "n" to add an event',
      'Colour-coded by type (release / task / contract / payment due)',
    ] },

  { path: '/salary',     group: 'Admin', title: 'Salary',
    intro: 'Monthly payroll roster, paid / unpaid status per employee per month.',
    tasks: [
      'Toggle paid status with a single click',
      'Every toggle logs who, when, and the action in payment history',
      'Filter by month or by employee',
    ] },
  { path: '/admin',      group: 'Admin', title: 'Admin Docs',
    intro: 'The document vault — company records reserved for Superadmin/Admin.',
    tasks: [
      'Upload and organize company documents',
      'Access is strictly admin-gated (no permission grant can open it)',
    ] },
  { path: '/legal',      group: 'Admin', title: 'Legal',
    intro: 'Legal document storage — waivers, clearances, and templates.',
    tasks: [
      'Central home for the label\'s legal records (admin-only)',
      'Waivers and clearances created from the Contracts pages surface here',
    ] },
  { path: '/analytics',  group: 'Admin', title: 'Analytics',
    intro: 'App usage at a glance — which pages get used, who\'s most active, and daily trends. Admin only.',
    tasks: [
      'Switch between 7 / 30 / 90 day windows',
      'Most-used pages ranked by views with unique-user counts',
      'Most active users: views, days active, logins, actions, last seen',
      'Daily activity chart tracks views and active users over time',
    ] },
  { path: '/activity',   group: 'Admin', title: 'Activity History',
    intro: 'Everything that happens in the app, labeled in plain English.',
    tasks: [
      'Press "s" to toggle sort order',
      'Filter by user, action, or page',
      'IP addresses recorded for security',
    ] },
  { path: '/settings',   group: 'Admin', title: 'Settings',
    intro: 'Theme and nav preferences for everyone; user management for admins.',
    tasks: [
      'My Nav hides pages you don\'t use from your sidebar; Theme switches light / dark',
      'Admins: invite users, set page permissions, reset passwords, adjust roles (incl. Approver — full bookkeeping without admin elsewhere)',
      'Admins: save any permission selection as a named template and apply it to other users (alongside the starter presets and copy-from-user)',
      'Admins: impersonate another user to see the app from their perspective',
      'Superadmins: create demo/test accounts that see mocked data only',
    ] },
]

// Keyboard shortcut groups (mirrors SHORTCUT_GROUPS in KeyboardShortcutsHelp.jsx)
const SHORTCUT_GROUPS = [
  { title: 'Global',           pages: [],                shortcuts: [
    { keys: '?', label: 'Show keyboard shortcut help' },
    { keys: '/', label: 'Focus search' },
    { keys: '⌘ K', label: 'Focus search' },
    { keys: 'Esc', label: 'Close modal or panel' },
  ]},
  { title: 'Releases',         pages: ['/releases'],     shortcuts: [
    { keys: 'n', label: 'New release' }, { keys: 'j', label: 'Next release' }, { keys: 'k', label: 'Previous release' },
    { keys: 'Enter', label: 'Expand / collapse release' }, { keys: 'v', label: 'Toggle list / calendar view' },
    { keys: '1–7', label: 'Switch tabs (Checklist / Metadata / DSP / Budget / Activity / Comments / Details)' },
  ]},
  { title: 'Ledger',           pages: ['/bk/ledger'],    shortcuts: [
    { keys: 'z', label: 'Undo last change' }, { keys: 'c', label: 'Toggle columns panel' }, { keys: 'x', label: 'Export Excel' },
  ]},
  { title: 'Deal Pipeline',    pages: ['/deals'],        shortcuts: [ { keys: 'n', label: 'New deal' } ] },
  { title: 'Approvals',        pages: ['/bk/approvals'], shortcuts: [
    { keys: 'j / k', label: 'Next / previous entry' }, { keys: 'a', label: 'Approve focused entry' },
    { keys: 'r', label: 'Reject focused entry' }, { keys: '⇧ A', label: 'Bulk approve all' },
  ]},
  { title: 'Create Invoice',   pages: ['/create-invoice'], shortcuts: [
    { keys: '⌘ Enter', label: 'Create / update invoice' }, { keys: '⌘⇧ L', label: 'Add line item' }, { keys: '⌘ P', label: 'Print / save PDF' },
  ]},
  { title: 'Calendar',         pages: ['/calendar'],     shortcuts: [
    { keys: '← / →', label: 'Previous / next month' }, { keys: 't', label: 'Jump to today' }, { keys: 'n', label: 'New event' },
  ]},
  { title: 'Catalog',          pages: ['/catalog'],      shortcuts: [
    { keys: 's', label: 'Sync artwork' }, { keys: '1–6', label: 'Date range presets' },
  ]},
]

// Cross-page workflows — each one requires canView access to its referenced pages.
const WORKFLOWS = [
  {
    title: 'Vendor invoice → payment',
    requires: ['/bk/approvals', '/bk/payments'],
    steps: [
      'Vendor submits on marketst-dashboard.up.railway.app/submit (no login needed) — they can list extra emails to be CC\'d on confirmations. The sidebar has one-click copies of both the form link and the Market Street billing address',
      'You review on Approvals — AI flags any discrepancies',
      'Approve (optionally with "Notify vendor") → entry lands on the Ledger',
      'On Payments, mark it paid, or upload the proof and let the AI scan mark it paid with the extracted date + reference',
      'Send the confirmation email from the row (or in bulk, grouped per vendor) — the vendor\'s saved emails are CC\'d automatically',
    ],
  },
  {
    title: 'Campaign expense needs a second pair of eyes',
    requires: ['/artist-campaigns'],
    steps: [
      'Flag the expense on Artist Campaigns (flag icon on the row, release, or artist)',
      'Assign one or more reviewers — it appears in their My Work "Waiting on you" rail and the Needs Review inbox',
      'Discuss in the comment thread under the notes, or @mention someone in the page chat',
      'Resolve by editing / splitting / reclassifying the row, then clear the flag',
    ],
  },
  {
    title: 'Monthly recoupment statement (cutoff: the 20th)',
    requires: ['/recoupments', '/recoupments/planning'],
    steps: [
      'Mark artists and releases "Ready for planning" from Recoupments or Artist Campaigns as they firm up (it\'s also a filter)',
      'On Recoupments, add the ready artists\' items to the plan, then open Recoupment Planning and group by song or label',
      'Use select-all + the selection bar to sanity-check $ totals; "Save for later" anything that slips',
      'Commit the selection to mass-mark UFR before the 20th — items land in that month\'s statement tab',
    ],
  },
  {
    title: 'Get a stack of invoices approved by Felipe',
    requires: ['/bk/payments'],
    steps: [
      'Open Payments, filter / sort to the items needing approval',
      'Use "Select All" or tick individual rows',
      'Click "Send for Approval"',
      'Choose recipient (Felipe, Jesse, or both), edit the message body if you want',
      'The email goes out with an Excel summary + PDFs of every selected invoice',
    ],
  },
  {
    title: 'Recoupable expense → Recoupments',
    requires: ['/bk/ledger', '/recoupments'],
    steps: [
      'On the Ledger, tick the Recoupable column on an expense',
      'The row appears on Recoupments, grouped by artist and song',
      'When you submit for recoupment, toggle UFR (Uploaded for Recoupment)',
      'Stat cards stay current across both pages',
    ],
  },
  {
    title: 'New artist → signed release',
    requires: ['/deals', '/contracts', '/releases'],
    steps: [
      'Add a deal in Deal Pipeline, drag it through Scouting → In talks',
      'Once ready, generate a contract (Contracts page or from the artist profile)',
      'Sign + upload the counter-signed PDF — contract flips to Active',
      'Create a release against the artist; work through the 14-item checklist',
    ],
  },
]

// Per-user content overrides. Matched case-insensitively against user.name.
// An override can add an extra prose block below a page's default tasks —
// used for role-specific guidance that doesn't apply to everyone.
const USER_OVERRIDES = {
  bradley: {
    '/releases': {
      extraTitle: 'Ingestion — adding new releases',
      extra: [
        'You own ingestion, so the Release Tracker is your workbench. Every new release starts here.',
        'Click "+ New Release" (or press "n" on the page) to open the add-release modal.',
        'Type the artist name into the Artist field — it autocompletes against existing artists; unknown names create a new artist record automatically.',
        'Fill Project Name, Release Date, Release Type (Single / EP / Album / Compilation), Genre, and Subgenre. These drive the catalog + analytics filters, so don\'t skip them.',
        'Set Priority (High / Medium / Low) based on marketing spend — this feeds the dashboard and team workload views.',
        'Producer and Featured Artists are free-text; comma-separate multiple names.',
        'After the release is created, click the row to expand it and work the 14-item checklist: YT Video, Recoup Added, Uploaded, Stem Pitch, S4A Pitch, Amazon Pitch, Pandora, Budget, Marketing Plan, Official Thread, Marquee, Content, DSP Email, Musixmatch. Tick items as they\'re done — each toggle auto-saves and shows up in the activity log.',
        'Add metadata (UPC, ISRC, Apple ID, Spotify URI) on the Metadata tab — press "2" while the row is open.',
        'Pre-save + presave analytics links go on the Details tab ("7"). Paste the full URL; the app extracts the short link for display.',
        'If an invoice on the Ledger mentions the artist + song, it auto-links to the release. Check the Budget tab ("4") to confirm each release is capturing its spend.',
        'Keyboard: j / k to move between releases, Enter to expand, 1–7 to switch tabs, v to toggle list / calendar view.',
      ],
    },
  },
}

// Split page paths into the permission namespace (strip trailing /:id etc.)
function basePath(p) {
  return p.split('/:')[0]
}

export default function UserManual() {
  const navigate = useNavigate()
  const { user: ctxUser, loading } = useAuth()

  // Fetch permissions live instead of trusting the AuthContext snapshot —
  // that way the manual reflects permission changes the admin just saved,
  // even if this tab has been open a while. Refetched on mount, window
  // focus, and cross-tab storage signals ("boom_permissions_updated").
  const [liveUser, setLiveUser] = useState(ctxUser)
  const [livePermissions, setLivePermissions] = useState(undefined) // undefined = loading
  const [refreshedAt, setRefreshedAt] = useState(Date.now())
  const [refreshing, setRefreshing] = useState(false)

  const refreshPermissions = useCallback(async () => {
    setRefreshing(true)
    try {
      const res = await api.get('/auth/me')
      const u = res.data.data
      setLiveUser(u)
      setLivePermissions(u.pagePermissions ?? null)
      setRefreshedAt(Date.now())
    } catch {
      // Fall back to context snapshot if the refetch fails
      setLivePermissions(null)
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => { refreshPermissions() }, [refreshPermissions])
  useEffect(() => {
    const onFocus = () => refreshPermissions()
    const onStorage = (e) => { if (e.key === 'boom_permissions_updated') refreshPermissions() }
    window.addEventListener('focus', onFocus)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('storage', onStorage)
    }
  }, [refreshPermissions])

  // canView backed by live permissions (falls back to context before first fetch)
  const canView = useCallback((path) => {
    const u = liveUser || ctxUser
    if (!u) return false
    if (['Superadmin', 'Admin'].includes(u.role)) return true
    const perms = livePermissions === undefined ? null : livePermissions
    if (perms === null) {
      // Mirror AuthContext: null permissions are default-CLOSED for Users
      // (Approvers fall back to the bookkeeping surface). The manual used
      // to render every page for null, promising pages the app then
      // bounced the user off of.
      if (u.role === 'Approver') {
        return path === '/' || path.startsWith('/bk/') || path.startsWith('/recoupments') || path === '/artist-campaigns'
      }
      return path === '/' || path === '/settings'
    }
    if (perms.includes(path)) return true
    if (path === '/recoupments/planning' && perms.includes('/recoupments')) return true
    return path === '/' || path === '/settings'
  }, [liveUser, ctxUser, livePermissions])

  const user = liveUser || ctxUser
  const today = useMemo(() =>
    new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    [])

  // Filter to only pages this user can view
  const visiblePages = useMemo(
    () => MANUAL_PAGES.filter(p => canView(basePath(p.path))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user, livePermissions]
  )
  // Group by their `group` label, preserving order
  const grouped = useMemo(() => {
    const order = []
    const map = {}
    for (const p of visiblePages) {
      if (!map[p.group]) { map[p.group] = []; order.push(p.group) }
      map[p.group].push(p)
    }
    return order.map(g => ({ label: g, pages: map[g] }))
  }, [visiblePages])

  const visibleShortcuts = useMemo(
    () => SHORTCUT_GROUPS.filter(g => g.pages.length === 0 || g.pages.some(p => canView(p))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user, livePermissions]
  )
  const visibleWorkflows = useMemo(
    () => WORKFLOWS.filter(w => w.requires.every(p => canView(p))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user, livePermissions]
  )

  if (loading) return null
  if (!user) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#888' }}>
        Please log in to view your manual. <a href="/login">Go to login →</a>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f4f4f5', color: '#111', fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Nunito, sans-serif", lineHeight: 1.55 }}>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg) } }
        @page { margin: 18mm }
        @media print {
          .no-print { display: none !important }
          body, html { background: #fff !important }
          .manual-root { background: #fff !important; padding: 0 !important }
          .manual-doc { box-shadow: none !important; border: none !important; margin: 0 !important; padding: 0 !important; max-width: none !important }
          .manual-group { page-break-before: always }
          .manual-group:first-of-type { page-break-before: avoid }
          h3, .manual-page { page-break-inside: avoid }
          a { color: #111; text-decoration: none }
        }
      `}</style>

      {/* Action bar (hidden in print) */}
      <div className="no-print" style={{
        position: 'sticky', top: 0, zIndex: 10, background: '#fff',
        borderBottom: '1px solid #e5e5e5', padding: '12px 24px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <button
          onClick={() => { if (window.history.length > 1) window.history.back(); else navigate('/') }}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            background: 'none', border: '1px solid #e5e5e5', borderRadius: 8,
            padding: '6px 12px', fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
            color: '#555', cursor: 'pointer',
          }}
        >
          <ArrowLeft size={14} /> Close
        </button>
        <div style={{ fontSize: 12, color: '#888', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span>Market Street Dashboard — User Manual</span>
          <button
            onClick={refreshPermissions}
            disabled={refreshing}
            title="Refetch your latest permissions"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              background: 'none', border: '1px solid #e5e5e5', borderRadius: 6,
              padding: '3px 8px', fontSize: 11, fontWeight: 600, fontFamily: 'inherit',
              color: '#888', cursor: refreshing ? 'default' : 'pointer',
              opacity: refreshing ? 0.5 : 1,
            }}
          >
            <RefreshCw size={11} style={refreshing ? { animation: 'spin 0.8s linear infinite' } : undefined} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        <button
          onClick={() => window.print()}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            background: '#334155', border: 'none', borderRadius: 8,
            padding: '8px 16px', fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
            color: '#fff', cursor: 'pointer',
          }}
        >
          <Printer size={14} /> Save as PDF
        </button>
      </div>

      <div className="manual-root" style={{ padding: '32px 24px' }}>
        <article className="manual-doc" style={{
          maxWidth: 820, margin: '0 auto', background: '#fff',
          border: '1px solid #e5e5e5', borderRadius: 14,
          boxShadow: '0 10px 40px rgba(0,0,0,.08)',
          padding: '48px 56px',
        }}>

          {/* Cover */}
          <div style={{ borderBottom: '3px solid #334155', paddingBottom: 24, marginBottom: 24 }}>
            <p style={{ margin: 0, fontSize: 11, fontWeight: 800, letterSpacing: 2, color: '#334155', textTransform: 'uppercase' }}>Market Street</p>
            <h1 style={{ margin: '4px 0 12px', fontSize: 32, fontWeight: 900, letterSpacing: -0.5 }}>User Manual</h1>
            <p style={{ margin: '0 0 6px', fontSize: 15 }}>
              Prepared for <strong>{user.name}</strong>
              {user.role && <> · <span style={{ color: '#666' }}>{user.role}</span></>}
              {user.department && <> · <span style={{ color: '#666' }}>{user.department}</span></>}
            </p>
            <p style={{ margin: 0, fontSize: 13, color: '#888' }}>Generated {today}</p>
          </div>

          {/* Intro */}
          <section style={{ marginBottom: 28 }}>
            <p style={{ margin: 0, fontSize: 14, color: '#333' }}>
              This manual covers every page you have access to, the workflows that span multiple pages,
              and the keyboard shortcuts that will save you the most time. Sections you can't access
              have been omitted. Save as PDF from the button above if you want a copy.
            </p>
          </section>

          {/* Contents */}
          <section style={{ marginBottom: 32 }}>
            <h2 style={{ fontSize: 13, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.5, color: '#666', margin: '0 0 10px' }}>Contents</h2>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: '#444' }}>
              {grouped.map(g => (
                <li key={g.label}>{g.label} <span style={{ color: '#999' }}>· {g.pages.length} page{g.pages.length === 1 ? '' : 's'}</span></li>
              ))}
              {visibleWorkflows.length > 0 && <li>Common workflows</li>}
              <li>Keyboard shortcuts</li>
            </ul>
          </section>

          {/* Page sections */}
          {grouped.map(group => (
            <section key={group.label} className="manual-group" style={{ marginBottom: 32 }}>
              <h2 style={{ fontSize: 18, fontWeight: 900, color: '#334155', margin: '0 0 4px', borderBottom: '1px solid #e5e5e5', paddingBottom: 6 }}>
                {group.label}
              </h2>
              {group.pages.map(p => {
                const nameKey = (user.name || '').trim().toLowerCase().split(/\s+/)[0]
                const override = USER_OVERRIDES[nameKey]?.[p.path]
                return (
                  <div key={p.path} className="manual-page" style={{ margin: '18px 0' }}>
                    <h3 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 800, display: 'flex', alignItems: 'baseline', gap: 8 }}>
                      {p.title}
                      <span style={{ fontSize: 11, fontWeight: 500, color: '#999', fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace' }}>{p.path}</span>
                    </h3>
                    <p style={{ margin: '0 0 6px', fontSize: 13, color: '#555' }}>{p.intro}</p>
                    <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: '#333' }}>
                      {p.tasks.map((t, i) => <li key={i} style={{ margin: '2px 0' }}>{t}</li>)}
                    </ul>
                    {override && (
                      <div style={{
                        marginTop: 10, padding: '12px 14px',
                        background: '#fff7ed', border: '1px solid #fed7aa', borderLeft: '3px solid #ea580c',
                        borderRadius: '0 6px 6px 0',
                      }}>
                        <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: '#9a3412', marginBottom: 6 }}>
                          For you, {(user.name || '').split(/\s+/)[0] || 'there'} — {override.extraTitle}
                        </div>
                        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: '#333' }}>
                          {override.extra.map((t, i) => <li key={i} style={{ margin: '3px 0' }}>{t}</li>)}
                        </ul>
                      </div>
                    )}
                  </div>
                )
              })}
            </section>
          ))}

          {/* Workflows */}
          {visibleWorkflows.length > 0 && (
            <section className="manual-group" style={{ marginBottom: 32 }}>
              <h2 style={{ fontSize: 18, fontWeight: 900, color: '#334155', margin: '0 0 4px', borderBottom: '1px solid #e5e5e5', paddingBottom: 6 }}>
                Common workflows
              </h2>
              {visibleWorkflows.map(w => (
                <div key={w.title} style={{ margin: '18px 0' }}>
                  <h3 style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 800 }}>{w.title}</h3>
                  <ol style={{ margin: 0, paddingLeft: 22, fontSize: 13, color: '#333' }}>
                    {w.steps.map((s, i) => <li key={i} style={{ margin: '2px 0' }}>{s}</li>)}
                  </ol>
                </div>
              ))}
            </section>
          )}

          {/* Keyboard shortcuts */}
          <section className="manual-group" style={{ marginBottom: 16 }}>
            <h2 style={{ fontSize: 18, fontWeight: 900, color: '#334155', margin: '0 0 4px', borderBottom: '1px solid #e5e5e5', paddingBottom: 6 }}>
              Keyboard shortcuts
            </h2>
            <p style={{ margin: '6px 0 14px', fontSize: 12, color: '#888' }}>Press <kbd style={{ fontFamily: 'ui-monospace', border: '1px solid #ddd', borderRadius: 3, padding: '0 5px', background: '#f5f5f5' }}>?</kbd> anywhere in the app to open this help.</p>
            {visibleShortcuts.map(g => (
              <div key={g.title} style={{ margin: '16px 0' }}>
                <h3 style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.5, color: '#666' }}>{g.title}</h3>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <tbody>
                    {g.shortcuts.map((s, i) => (
                      <tr key={i}>
                        <td style={{ padding: '4px 0', width: 120, whiteSpace: 'nowrap' }}>
                          <kbd style={{ fontFamily: 'ui-monospace', border: '1px solid #ddd', borderRadius: 4, padding: '1px 6px', background: '#f5f5f5', fontSize: 12 }}>{s.keys}</kbd>
                        </td>
                        <td style={{ padding: '4px 0', color: '#444' }}>{s.label}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </section>

          <div style={{ marginTop: 40, paddingTop: 16, borderTop: '1px solid #e5e5e5', fontSize: 11, color: '#999', textAlign: 'center' }}>
            Market Street Dashboard · marketst-dashboard.up.railway.app · Manual generated {today}
          </div>
        </article>
      </div>
    </div>
  )
}
