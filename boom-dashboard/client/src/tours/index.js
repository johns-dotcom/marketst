// The click-through tours. ONE file, read by components/Tour.jsx (the
// spotlight engine), the help modal (the list), and
// client/scripts/tours-fixture.mjs — which FAILS when a tour names a page
// that is not in the nav or points at an element no page renders.
//
// Rule (2026-09-19): a change to a page changes its tour in the same commit,
// and bumps that tour's `version` (a date). A person who finished an older
// version sees the tour offered again as "updated".
//
// `target` is a CSS selector. Pages mark the elements a tour talks about with
// `data-tour="…"` (or an existing data- attribute the page already has).
// A step whose target is not on screen is skipped, never shown as an empty
// spotlight; if no step of a tour has a target, the tour does not start.
// `path` gates the tour with the same canView the sidebar uses: a bookkeeper
// never sees the Deals tour.
import { NAV_GROUPS } from '../navConfig'
import { PAGE_KEYS, keysSentence } from '../lib/shortcuts'
const PAGE_TOURS = [
  {
    id: 'home', title: 'Home', path: '/', version: '2026-09-21',
    steps: [
      { target: '[data-tour="home-loop"]', title: 'The loop', body: 'Invoices arrive, get approved, get paid, the bank statement proves it, reports read from that. One tile per step.' },
      { target: '[data-quick-actions]', title: 'Start something', body: 'Add an invoice, add a release, open a new deal. Only the actions for pages you can open.' },
      { target: '[data-week]', title: 'The next seven days', body: 'From the team calendar: release dates, payment due dates, task deadlines, renewals. Each links to its page.' },
      { target: '[data-activity]', needs: '/activity', title: 'What the team did', body: "Everyone else's recent changes, newest first, with any alerts on top." },
    ],
  },
  {
    id: 'releases', title: 'Releases', path: '/releases', version: '2026-09-20',
    steps: [
      { target: '[data-tour="releases-header"]', title: 'The pipeline', body: 'Every release in progress with its checklist. Add Release starts one; the toggle beside it switches between the list and a calendar.' },
      { target: '[data-tour="releases-filters"], [data-tour="releases-header"]', title: 'Filters', body: 'Search, then year, month, genre, priority and type. Archived shows retired releases.' },
      { target: '[data-tour="releases-list"], [data-tour="releases-header"]', title: 'One row per release', body: 'Click a row to expand it: Checklist, Metadata & Links, DSP, Budget, Activity, Comments, Details. Tick two rows and a merge bar appears for duplicates. Once it ships, it moves to Catalog.' },
    ],
  },
  {
    id: 'deals', title: 'Deals', path: '/deals', version: '2026-09-21',
    steps: [
      { target: '[data-tour="deals-header"]', title: 'Scouting to Signed', body: 'Prospects move left to right across four live stages. The subtitle counts what is live, the advances on the table, and how many deals need attention. Every deal has an OWNER — their follow-ups land in My Work and on the calendar.' },
      { target: '[data-tour="deals-views"], [data-tour="deals-header"]', title: 'Board, list, report', body: 'The same deals three ways. The list sorts by any column; the report is the funnel — how many reached each stage, days per stage, win rate by source and by owner, why we passed.' },
      { target: '[data-tour="deals-filters"], [data-tour="deals-header"]', title: 'Filters live in the URL', body: 'Search, owner (Mine), type, priority, and Needs attention — an overdue follow-up or a deal stuck past 21 days. Copy the address to share the view.' },
      { target: '[data-tour="deal-board"], [data-tour="deals-header"]', title: 'The board', body: 'Drag a card between columns or press Next. Each card shows its owner, days in stage (amber at 14, red at 21), the follow-up, the last touch and the advance. Open a card for its timeline — dated notes and every stage move — and the Before Signed checklist.' },
      { target: '[data-tour="deals-closed"], [data-tour="deal-board"], [data-tour="deals-header"]', title: 'Signed and Passed fold away', body: 'The board is the work; these two are the record. Drop a card on a header to close it. Passing asks why and whether to revisit — the date comes back as a flag and a calendar event.' },
      { target: '[data-tour="deals-new"], [data-tour="deals-header"]', title: 'Signed does the work', body: 'Moving a deal to Signed creates the roster artist, books the advance as an approved recoupable expense, adds a calendar event and hands you to a prefilled contract.' },
    ],
  },
  {
    id: 'contracts', title: 'Contracts', path: '/contracts', version: '2026-09-20',
    steps: [
      { target: '[data-tour="contracts-header"]', title: 'Contracts on file', body: 'Every artist agreement with its dates, split and documents. New Contract opens a form you can autofill by dropping the PDF — the AI reads the terms.' },
      { target: '[data-tour="contracts-filters"], [data-tour="contracts-header"]', title: 'Find one', body: 'Search, type and status. Above the filters, two folds warn about artists with no contract and contracts expiring soon.' },
      { target: '[data-tour="contracts-attach"], [data-tour="contracts-header"]', title: 'Attach a document', body: 'Pick the contract and drop the signed PDF. It also lands on the artist\'s Documents tab.' },
      { target: '[data-tour="contracts-table"], [data-tour="contracts-header"]', title: 'The table', body: 'Click a row for the detail view: terms, financial obligations, documents and everything linked to it. The pen icon sends the PDF for signature through DocuSign; the badge beside it shows who still has to sign.' },
    ],
  },
  {
    id: 'artists', title: 'Artists', path: '/artists', version: '2026-09-20',
    steps: [
      { target: '[data-tour="artists-header"]', title: 'The roster', body: 'Everyone signed to the label. Add artist creates a profile by hand; a deal moved to Signed does it for you. Export builds a spreadsheet by release window and genre.' },
      { target: '[data-tour="artists-stats"], [data-tour="artists-header"]', title: 'At a glance', body: 'Artists, genres, releases and the active roster. The Onboarding filter in the header shows only artists still being set up.' },
      { target: '[data-tour="artists-filters"], [data-tour="artists-search"], [data-tour="artists-header"]', title: 'Filter and sort', body: 'Genre, recent release activity, active only, and the sort order. Search is in the header.' },
      { target: '[data-tour="artist-card"], [data-tour="artists-header"]', title: 'Open a profile', body: 'Each card shows genre, releases and the daily Spotify follower count. The profile is the hub: releases, contracts, documents, budget, recoupments, campaigns, and the onboarding checklist for a newly signed artist.' },
    ],
  },
  {
    id: 'artist-profile', title: "An artist's profile", path: '/artists', version: '2026-09-20', match: /^\/artists\/\d+/,
    steps: [
      { target: '[data-onboarding], [data-tour="artist-tabs"]', title: 'Onboarding', body: 'For an artist signed through the pipeline: contract on file, payment details and W-9, advance paid, budget set, first release. It ticks itself from the data and collapses when complete.' },
      { target: '[data-tour="artist-tabs"]', title: 'Every side of the artist', body: 'Spotify (followers and popularity tracked daily, monthly listeners when Chartmetric is on), releases and contracts, then the money: Budget, Recoupments and Campaigns, each read-only here with a link to its full page.' },
    ],
  },
  {
    id: 'approvals', title: 'Approvals', path: '/bk/approvals', version: '2026-09-20',
    steps: [
      { target: '[data-tour="approvals"]', title: 'Invoices waiting', body: 'Everything submitted and not yet approved. Approve, reject, edit or split from here; a rejection emails the vendor the reason.' },
      { target: '[data-tour="approvals-toolbar"], [data-tour="approvals"]', title: 'Search, filter, review', body: 'Search, filter by rep and category. Review all opens the checklist deck over every filtered invoice; Review W-9s appears when W-9s need a look. Keys: j and k move, a approves, r rejects.' },
      { target: '[data-tour="approvals-review"], [data-tour="approvals"]', title: 'The checklist deck', body: 'Each approval confirms artist, song, amount and category and answers bulk deal, cobrand, recoupable and campaign. Nothing is approved without it. Approved invoices push to QuickBooks when it is connected.' },
    ],
  },
  {
    id: 'payments', title: 'Payments', path: '/bk/payments', version: '2026-09-20',
    steps: [
      { target: '[data-tour="payments"]', title: 'What to pay next', body: 'Approved and unpaid, ordered by when it is due. Mark paid, attach proof, send the vendor a confirmation, or hold and rush.' },
      { target: '[data-tour="payments-stats"], [data-tour="payments"]', title: 'The cards are filters', body: 'Overdue, due this week, total unpaid — click one to narrow the table. The chips below cover the workflow states with no card of their own.' },
      { target: '[data-tour="payments-table"], [data-tour="payments"]', title: 'The table', body: 'Search and an amount filter at the top. Each row marks paid with method and reference, edits the due date, shows blockers, and sends the confirmation email with proof attached.' },
      { target: '[data-tour="payments-actions"], [data-tour="payments"]', title: 'Bulk actions', body: 'The bar at the bottom shows the filtered and selected totals and acts on the selection: mark paid, rush, hold, send confirmations, CC the rep. Paid invoices push to QuickBooks when it is connected.' },
    ],
  },
  {
    id: 'calendar', title: 'Calendar', path: '/calendar', version: '2026-09-20',
    steps: [
      { target: '[data-tour="calendar-header"], [data-tour="calendar-grid"]', title: 'The team calendar', body: 'Release dates, DSP dates, signings, contract renewals, task deadlines and payment due dates, in one feed. Add Event adds a manual one.' },
      { target: '[data-tour="calendar-grid"]', title: 'The month', body: 'Move month to month or jump to Today. Click a day to list its events; each links to its page.' },
      { target: '[data-tour="calendar-side"], [data-tour="calendar-grid"]', title: 'The day, or the next two weeks', body: 'The side card shows the selected day, or the next fourteen days when nothing is selected.' },
      { target: '[data-legend]', title: 'The legend is the filter', body: 'Each row toggles a source and shows its count. A locked row is a source your account cannot open. Show all resets.' },
    ],
  },
  {
    id: 'people', title: 'People', path: '/team', version: '2026-09-20', roles: ['Admin', 'Superadmin'],
    steps: [
      { target: '[data-tour="people-header"], [data-directory]', title: 'Everyone with an account', body: 'Role, department, what they can open, last sign-in, open tasks. Keys 1 to 4 switch between Directory, Tasks, Workload and Velocity.' },
      { target: '[data-directory], [data-invite]', title: 'The directory', body: 'Click a row to edit the person or open their profile; the Access tab there is where pages are granted. An unused invite says so beside the last sign-in, with a resend.' },
      { target: '[data-invite], [data-tour="people-header"]', title: 'Adding a person', body: 'Name, email, department. The department picks a starting preset of pages; presets add up. The invite link appears once — copy it or email it. Only a Superadmin can hand out Admin or Superadmin.' },
    ],
  },
  {
    id: 'settings', title: 'Settings', path: '/settings', version: '2026-09-20',
    steps: [
      { target: '[data-settings-shell] aside', title: 'Two halves', body: "My settings is yours: profile, sign-in, notifications, your own mailbox, theme, sidebar. Label settings is the label's: people, the label record, integrations, roles, activity, admin docs, archive — admins only. Roles explains what a Superadmin, Admin, Approver and User can each do." },
      { target: '[data-settings-content]', title: 'The page', body: 'Each rail item is its own page here. My Nav hides sidebar pages you never use; Notifications chooses which events email you; My mailbox connects your own address.' },
      { target: '[data-tour="settings-label-group"], [data-settings-shell] aside', title: 'Label settings', body: 'Label is what prints on invoices and documents. Integrations connects mail, QuickBooks and DocuSign. Roles is the reference for who can do what.', roles: ['Admin', 'Superadmin'] },
    ],
  },
  {
    id: 'brand', title: 'Brand', path: '/brand', version: '2026-09-20',
    steps: [
      { target: '[data-tour="brand-header"], [data-brand-drop]', title: 'Logos and photos', body: 'The label\'s brand assets, for anyone on the team to grab. Add what people will need; download what you need.' },
      { target: '[data-brand-drop]', title: 'Upload', body: 'Drop files or choose them, filed as logo, photo or other. Vector logos download as files rather than previewing.' },
      { target: '[data-brand-filter]', title: 'Find and download', body: 'Filter by category; each tile downloads. Remove is for your own uploads, or any for an admin.' },
    ],
  },
  {
    id: 'my-work', title: 'My Work', path: '/my-work', version: '2026-09-21',
    steps: [
      { target: '[data-tour="my-work-add"]', title: 'Add a task', body: 'Type it and press Enter. @ assigns it to a teammate; the chips set priority, category and due date. Press n anywhere on this page to jump here.' },
      { target: '[data-tour="my-work-list"]', title: 'Your list, by when', body: 'Overdue, today, this week, later, no date. Click anywhere on a row to open it — status, priority, category, due date, who it is for, and the full notes. Notes work like a small document: bullets, numbered lists, checklists you can tick, headings, bold. Enter continues a list, Tab indents, and it saves as you type. The circle marks it done.' },
      { target: '[data-tour="my-work-week"]', title: 'This week, mine', body: 'From the team calendar, kept to what involves you: your task deadlines, your releases, and the money dates you can open.' },
      { target: '[data-tour="my-work-waiting"], [data-tour="my-work-list"]', title: 'Waiting on you', body: 'Only things you can unblock: invoices for your approval, mentions, invites you sent that nobody used, the statement cutoff. It disappears when there is nothing.' },
    ],
  },
  // ─── General ────────────────────────────────────────────────────────────
  {
    id: 'messages', title: 'Messages', path: '/messages', version: '2026-09-20',
    steps: [
      { target: '[data-tour="messages-rail"]', title: 'Channels and direct messages', body: 'The rail on the left: channels for a topic or a release, direct messages for a person. New channel and New message live at the top of each group; Browse finds public channels you are not in yet.' },
      { target: '[data-tour="messages-search"], [data-tour="messages-rail"]', title: 'Search every conversation', body: 'The search box at the top of the rail looks through every message you can see and swaps the rail for the results.' },
      { target: '[data-tour="messages-pane"]', title: 'The conversation', body: 'Enter sends, Shift+Enter starts a new line, @ mentions a teammate (they get an email if they are offline), and a paste or a drag drops a file in. Reply on a message to open its thread.' },
    ],
  },
  {
    id: 'flags', title: 'Flags', path: '/flags', version: '2026-09-21',
    steps: [
      { target: '[data-tour="flags-header"]', title: 'Everything that needs a decision', body: 'One register for the whole label: setup gaps, stalled approvals and payments, signatures out too long, compliance holes, duplicates and blanks. The subtitle counts what needs a decision and what is new since you last looked.' },
      { target: '[data-flags-meta], [data-flags-refresh], [data-tour="flags-header"]', title: 'Checked every hour', body: 'Every check runs hourly and this line says when it last ran. A check that could not run is named here — silence never means clear. Admins can run the checks now.' },
      { target: '[data-tour="flags-nav"], [data-tour="flags-overview"], [data-tour="flags-header"]', title: 'Groups, only what has something in it', body: 'Setup first (it blocks everything else on a new label), then Money, Workflow, Compliance, Ledger, Catalog, Artists. Zero-count checks fold into one "checks clear" line; a dot marks a category with something new.' },
      { target: '[data-tour="flags-overview"], [data-register-section], [data-tour="flags-nav"]', title: 'Open a category', body: 'Each row says what, how old, how much, and who holds it. Open goes to the page that resolves it; Assign makes a task in someone\'s My Work that closes itself when the flag clears; Snooze and Dismiss remember the value, so a row that changes comes back.' },
    ],
  },
  // ─── Releases family ────────────────────────────────────────────────────
  {
    id: 'catalog', title: 'Catalog', path: '/catalog', version: '2026-09-20',
    steps: [
      { target: '[data-tour="catalog-header"]', title: 'Everything released', body: 'The catalog is every release that has shipped, as cover art by year. Sync Artwork pulls covers from Spotify; View archived shows what was retired.' },
      { target: '[data-tour="catalog-filters"]', title: 'Narrow it down', body: 'Search, then filter by artist, genre and type. Keys 1 to 6 set the time window (all, this year, 6, 12, 24 months, custom); s syncs artwork.' },
      { target: '[data-tour="catalog-grid"], [data-tour="catalog-filters"]', title: 'The cards', body: 'Hover a card for Spotify and Apple links, or to move a release back to the pipeline.' },
    ],
  },
  // ─── Contracts family ───────────────────────────────────────────────────
  {
    id: 'pending-contracts', title: 'Pending contracts', path: '/pending-contracts', version: '2026-09-20', roles: ['Admin', 'Superadmin'],
    steps: [
      { target: '[data-tour="pending-header"]', title: 'Contracts out for signature', body: 'Artists whose paperwork is in flight, with counts for sent, not sent and signed. Add Artist starts a row by hand.' },
      { target: '[data-tour="pending-list"], [data-tour="pending-header"]', title: 'One row per artist', body: 'Search or filter by status; the chevron on a row expands its deal terms and contact details.' },
    ],
  },
  {
    id: 'renewals', title: 'Renewals', path: '/renewals', version: '2026-09-20', roles: ['Admin', 'Superadmin'],
    steps: [
      { target: '[data-tour="renewals-header"]', title: 'Expiry dates, in order', body: 'Every active contract by how soon it ends. The four cards count total, expiring soon, within 90 days and active.' },
      { target: '[data-tour="renewals-table"]', title: 'The table', body: 'Filter with the pills, then read the days-left column: it goes amber inside 90 days and red past expiry. Renewals also appear on the team calendar.' },
    ],
  },
  // ─── Documents family ───────────────────────────────────────────────────
  {
    id: 'create-contract', title: 'Contract draft', path: '/contracts/create', version: '2026-09-20', roles: ['Admin', 'Superadmin'],
    steps: [
      { target: '[data-tour="create-contract-header"]', title: 'A draft from your own contracts', body: 'Fill in artist, type, split, advance, territory and term; AI drafts a contract using the ones already on file as reference. Nothing is saved here — copy or download the text.' },
    ],
  },
  {
    id: 'create-nda', title: 'NDAs', path: '/create-nda', version: '2026-09-20',
    steps: [
      { target: '[data-tour="nda-form"]', title: 'The form', body: 'Effective date, both parties, the recipient\'s email (that is where DocuSign sends it), the signatory. Names and address come from Settings › Label. The body text is editable; Reset returns it to the template.' },
      { target: '[data-tour="nda-preview"], [data-tour="nda-form"]', title: 'Preview as you type', body: 'The right column is the PDF as it will print. Save NDA stores it and, when the recipient is on the roster, files the PDF on that artist\'s Documents.' },
      { target: '[data-tour="nda-form"]', title: 'Saved NDAs', body: 'Below the form, every saved NDA: edit, preview, download PDF or Word, delete, or send it for signature with the pen icon — the badge beside it shows who still has to sign.' },
    ],
  },
  {
    id: 'create-label-waiver', title: 'Label waivers', path: '/create-label-waiver', version: '2026-09-20',
    steps: [
      { target: '[data-tour="waiver-form"]', title: 'A waiver for a song', body: 'Pick the Market Street artist from the roster (that is what files the PDF to their Documents), name the other label and their artist, the song, the date, the format and the royalty.' },
      { target: '[data-tour="waiver-preview"], [data-tour="waiver-form"]', title: 'Preview and save', body: 'The body rebuilds from the template until you edit it. Save waiver stores it; saved waivers list below with preview, download, DocuSign and delete.' },
    ],
  },
  {
    id: 'create-artist-clearance', title: 'Clearance charts', path: '/create-artist-clearance', version: '2026-09-20',
    steps: [
      { target: '[data-tour="clearance-form"]', title: 'A clearance chart per project', body: 'Pick the artist, the project and its terms, then add tracks — From catalog fills them from what the artist has released, Blank track adds one by hand. Each track expands to its writer and sample details.' },
      { target: '[data-tour="clearance-form"]', title: 'Saving makes a spreadsheet', body: 'Save produces an XLSX and files it on the artist\'s Documents; saving again replaces the same file. Saved charts list below.' },
    ],
  },
  {
    id: 'create-invoice', title: 'Invoices you send', path: '/create-invoice', version: '2026-09-20',
    steps: [
      { target: '[data-tour="invoice-form"]', title: 'Bill a client', body: 'Who to bill, the date, the terms (the due date is worked out for you) and the line items. The remittance block prints from Settings › Label. ⌘Enter saves, ⌘⇧L adds a line, ⌘P downloads the PDF.' },
      { target: '[data-tour="invoice-preview"], [data-tour="invoice-form"]', title: 'Preview, then the list', body: 'The preview is the printed invoice. Saved invoices list below as a table or cards, with download and edit.' },
    ],
  },
  // ─── Money: Invoices family ─────────────────────────────────────────────
  {
    id: 'ledger', title: 'Ledger', path: '/bk/ledger', version: '2026-09-23',
    steps: [
      { target: '[data-tour="ledger-toolbar"]', title: 'Every approved invoice', body: 'The register of everything approved. Search, a date range and a sort sit in the toolbar; the filters live behind one button and show as chips; a set of filters can be saved as a view. The URL carries them, so a link shares the exact view.' },
      { target: '[data-ledger-attention], [data-tour="ledger-filters"], [data-tour="ledger-toolbar"]', title: 'Needs attention', body: 'One toggle for rows missing a document or a W-9, paid with no bank line, not in QuickBooks, or flagged. The count says how many.' },
      { target: '[data-ledger-summary], [data-tour="ledger-toolbar"]', title: 'The numbers for this filter', body: 'Rows, total by currency, paid against unpaid and the attention count for whatever the filter holds. Group by vendor, artist, category or month to get a subtotal row per group.' },
      { target: '[data-tour="ledger-table"], [data-tour="ledger-toolbar"]', title: 'Open a row', body: 'The › on a row, a double-click, or Enter opens a drawer with every field, the documents, the split family, bank evidence, QuickBooks and the change history. From there: Clone it, save it as a template, or drop a file on it to attach one. Columns keeps the table to a core set; the rest are one click away.' },
    ],
  },
  {
    id: 'creators', title: 'Creator payments', path: '/bk/creators', version: '2026-09-20',
    steps: [
      { target: '[data-tour="creators-header"]', title: 'Paid without an invoice', body: 'Small payments to creators and influencers, tracked so they match PayPal statements and count in campaigns and recoupments. Record a payment enters a batch at once.' },
      { target: '[data-tour="creators-tabs"], [data-tour="creators-header"]', title: 'Three views', body: 'Payments is the list; Creators is the directory with W-9 status; To move in is what the classifier thinks belongs here from the ledger — tick and move them.' },
      { target: '[data-tour="creators-table"], [data-tour="creators-search"], [data-tour="creators-header"]', title: 'The list', body: 'Search by creator, handle, artist or song. Each row marks paid or unpaid in place.' },
    ],
  },
  {
    id: 'add-invoice', title: 'Add an invoice', path: '/bk/add', version: '2026-09-20',
    steps: [
      { target: '[data-tour="add-invoice-header"]', title: 'From PDF to ledger', body: 'Drop the vendor\'s invoice; the AI reads payee, number, amount, date and lines and fills the form. Check what it read before saving.' },
      { target: '[data-tour="add-invoice-upload"]', title: 'Upload first', body: 'The invoice PDF goes here; W-9 and proof of payment have their own slots below. Parse with AI appears once a file is chosen.' },
      { target: '[data-tour="add-invoice-fields"]', title: 'The fields', body: 'Payee (with vendor suggestions and W-9 status), category, artist, song, invoice number, amount, currency, method, rep. Splits across artists live under Artist Split.' },
      { target: '[data-tour="add-invoice-submit"], [data-tour="add-invoice-status"]', title: 'Save, or review and save', body: 'Approvers and admins go through the checklist deck and the invoice files as approved; everyone else\'s invoice waits in Approvals.' },
    ],
  },
  // ─── Money: Bank family ─────────────────────────────────────────────────
  {
    id: 'bank-matching', title: 'Bank: for review', path: '/bk/bank-matching', version: '2026-09-20', roles: ['Admin', 'Superadmin'],
    steps: [
      { target: '[data-tour="bank-scope"], [data-tour="bank-matching"]', title: 'Pick a statement', body: 'The band above the tabs chooses the statement; its tie-out (opened, in, out, closed) and how many lines are left to review follow it across the Bank pages.' },
      { target: '[data-tour="bank-matching-review"], [data-tour="bank-matching-direction"], [data-tour="bank-matching"]', title: 'Review the lines', body: 'Each bank line is evidence: match it to an invoice, book it as an expense, or set it aside. Review opens a deck — → accept, ← skip, N no invoice, F flag, 1 to 9 pick a category, Esc closes.' },
      { target: '[data-tour="bank-matching-filters"], [data-tour="bank-matching"]', title: 'Filters and bulk actions', body: 'Filter tabs, search and Refine narrow the mini-ledger; re-run matching after a rule changes. The direction switch flips to ledger → statement to find invoices with no bank line.' },
    ],
  },
  {
    id: 'bank-ledger', title: 'Bank: categorized', path: '/bk/bank-ledger', version: '2026-09-20', roles: ['Admin', 'Superadmin'],
    steps: [
      { target: '[data-tour="ledger-toolbar"]', title: 'Money that left with no invoice', body: 'Rows the app created from bank debits — subscriptions, fees, card spend. Same toolbar as the invoiced ledger; the statement scope comes from the band above.' },
      { target: '[data-tour="ledger-filters"], [data-tour="ledger-toolbar"]', title: 'Out, in, both', body: 'With a statement picked you can show debits, credits or both, then cut by source, category and artist like the other half.' },
    ],
  },
  {
    id: 'statements', title: 'Statements', path: '/bk/statements', version: '2026-09-20', roles: ['Admin', 'Superadmin'],
    steps: [
      { target: '[data-tour="statements-header"]', title: 'The bank statements', body: 'Upload each month\'s statement PDF; the app reads the lines and reconciles them against the ledger. Drop a file anywhere on this page.' },
      { target: '[data-tour="statements-upload"], [data-tour="statements-header"]', title: 'Upload', body: 'Choose the account, then Upload. Once a statement is ready, Review & match takes you to Bank › For review; Flags shows what the read found odd.' },
      { target: '[data-tour="statements-search"], [data-tour="statements-header"]', title: 'Find any transaction', body: 'The search looks through every statement on file. Below it, the library lists statements by month with their totals and whether they tie out.' },
    ],
  },
  {
    id: 'rules', title: 'Upload rules', path: '/bk/rules', version: '2026-09-20', roles: ['Admin', 'Superadmin'],
    steps: [
      { target: '[data-tour="rules-header"]', title: 'Standing decisions', body: 'One question decides a bank line: will it ever have an invoice? Rules answer it once — a payee that never invoices, a category to book to, a line to ignore.' },
      { target: '[data-tour="rules-in-force"]', title: 'In force', body: 'Suggestions from what you have matched appear above; accept one and it applies to the next upload. This card is every rule in force, by kind. Rules are not tied to the statement picked above.' },
    ],
  },
  // ─── Money: Vendors family ──────────────────────────────────────────────
  {
    id: 'vendors', title: 'Vendors', path: '/bk/vendors', version: '2026-09-20', roles: ['Admin', 'Superadmin', 'Approver'],
    steps: [
      { target: '[data-tour="vendors-header"]', title: 'Everyone you pay', body: 'The directory is built from the ledger\'s payees: aliases, emails, bank payees and W-9 status in one place.' },
      { target: '[data-tour="vendors-views"], [data-tour="vendors-header"]', title: 'Worklists', body: 'Directory is the whole list; the worklists are vendors that need an invoice, an artist, or a bank payee attached; Duplicates finds names that are the same vendor.' },
      { target: '[data-tour="vendors-table"], [data-tour="vendors-search"], [data-tour="vendors-header"]', title: 'The table', body: 'Search by name, alias, email or bank payee. A row jumps to its statements or merges into another vendor. Unlinked bank payees collapse at the bottom.' },
    ],
  },
  {
    id: 'tax-1099', title: '1099 filing', path: '/bk/1099', version: '2026-09-20',
    steps: [
      { target: '[data-tour="tax-header"]', title: 'Who gets a form', body: 'Cash basis: payments that left in the calendar year, per vendor, against the threshold. The five cards say who gets a form, who cannot be filed yet, and why.' },
      { target: '[data-tour="tax-year"], [data-tour="tax-header"]', title: 'Year, then read the W-9s', body: 'Pick the year. Read the W-9s scans each vendor\'s W-9 for the TIN and entity type in batches; it can take a while.' },
      { target: '[data-tour="tax-buckets"], [data-tour="tax-download"], [data-tour="tax-header"]', title: 'Buckets and the workbook', body: 'Reportable, needs attention, excluded, under the threshold. Download workbook is masked; the full-TIN version is for admins and is audit-logged.' },
    ],
  },
  // ─── Hidden Money pages (reachable by link, not in the sidebar) ────────
  {
    id: 'reimburse', title: 'Add a reimbursement', path: '/bk/reimburse', version: '2026-09-20',
    steps: [
      { target: '[data-tour="reimburse-header"]', title: 'Paid personally, paid back', body: 'The reimbursement twin of Add invoice: receipts and proof of payment instead of a vendor invoice. The same toggle exists on Add invoice.' },
      { target: '[data-tour="reimburse-fields"], [data-tour="reimburse-upload"]', title: 'The fields', body: 'Date, who was paid, category, artist, song, amount, method, rep, then the description and notes. Splits across artists work the same way.' },
      { target: '[data-tour="reimburse-submit"], [data-tour="reimburse-header"]', title: 'Submit', body: 'It lands in Approvals like any invoice.' },
    ],
  },
  {
    id: 'invoices-view', title: 'Invoices view', path: '/bk/invoices', version: '2026-09-20',
    steps: [
      { target: '[data-tour="invoices-range"]', title: 'Submissions and payments by week', body: 'Two charts: what came in and what was paid. Click a bar to filter the list to that week — it also switches which date the filter uses.' },
      { target: '[data-tour="invoices-toolbar"]', title: 'Search and dates', body: 'Search payee, description or number; set from and to; switch between a table and cards. Rejected invoices collapse at the bottom.' },
    ],
  },
  {
    id: 'bulk-deals', title: 'Bulk deals', path: '/bk/bulk-deals', version: '2026-09-20',
    steps: [
      { target: '[data-tour="bulk-deals-header"]', title: 'Deliverables against a deal', body: 'A bulk deal is an invoice marked as one on the Ledger or Add invoice — this page cannot create one. Each card tracks contracted items against what was delivered and paid.' },
      { target: '[data-tour="bulk-deals-list"], [data-tour="bulk-deals-header"]', title: 'The cards', body: 'Open a card to edit its parameters, the artist split, the creators\' socials, and to add delivered items with their evidence links.' },
    ],
  },
  {
    id: 'ledger-matching', title: 'Bookkeeper reconcile', path: '/bk/ledger-matching', version: '2026-09-20',
    steps: [
      { target: '[data-tour="reconcile-header"]', title: 'Diff the accountant\'s spreadsheet', body: 'Upload the bookkeeper\'s ledger export and the app flags every difference against its own. This is not bank matching — that lives under Bank.' },
      { target: '[data-tour="reconcile-requirements"]', title: 'What the spreadsheet needs', body: 'The columns the diff reads. Anything else is ignored.' },
      { target: '[data-tour="reconcile-run"], [data-tour="reconcile-upload"]', title: 'Upload, then match', body: 'Pick the file and run. Results group by category with exports for the bookkeeper: a handoff ZIP, the full report, or a BK-style spreadsheet.' },
    ],
  },
  // ─── Reports ────────────────────────────────────────────────────────────
  {
    id: 'reports', title: 'Reports', path: '/reports', version: '2026-09-22',
    steps: [
      { target: '[data-tour="reports-header"]', title: 'The numbers', body: 'P&L, balance sheet, spend by artist, vendor and rep, budget vs actual, and the dismissed list. Every figure opens to the rows behind it.' },
      { target: '[data-basis-switch], [data-tour="reports-header"]', title: 'Pick the basis', body: 'Bank statements counts only money the bank proves. Ledger — paid counts every paid invoice by payment date, statement or not. Accrual counts everything invoiced, paid or not. The default follows the data: ledger until a bank month is reconciled.' },
      { target: '[data-tour="reports-controls"]', title: 'Range, columns, comparison', body: 'Set from and to, then months, quarters or years across, and compare with the previous period or the same period last year. Charts toggles the pictures above the table.' },
      { target: '[data-report-charts], [data-charts-empty], [data-tour="reports-controls"]', title: 'The charts', body: 'Income, expenses and net by period; where the money went; spend by artist; invoices received by month, with how many; top vendors; the running net. Click a bar to open its rows.' },
      { target: '[data-pack-open], [data-tour="reports-controls"]', title: 'The accountant pack', body: 'One workbook: a cover stating period, basis and what was excluded, then P&L, balance sheet, spend by artist, vendor and rep, and the dismissed list. Download it now, or have it emailed on a day each month.' },
    ],
  },
  // ─── Admin ──────────────────────────────────────────────────────────────
  {
    id: 'admin-docs', title: 'Admin docs', path: '/admin', version: '2026-09-20', roles: ['Admin', 'Superadmin'],
    steps: [
      { target: '[data-tour="admin-docs-header"]', title: 'The label\'s own documents', body: 'Legal, compliance, HR, IP, policies and templates. Upload File or New Document adds one; drop files anywhere on the page to create one per file.' },
      { target: '[data-tour="admin-docs-list"], [data-tour="admin-docs-header"]', title: 'Find and open', body: 'Search, filter by status and confidentiality, or pick a category tab. Restricted documents are visible to Superadmins only. Expiring documents are flagged at the top 60 days out.' },
    ],
  },
  // ─── Reports: Recoupments family ────────────────────────────────────────
  {
    id: 'recoupments', title: 'Recoupments', path: '/recoupments', version: '2026-09-20',
    steps: [
      { target: '[data-tour="recoupments-header"]', title: 'Recoupable spend, by artist', body: 'Every recoupable item, grouped by artist, in four states: ready to upload (paid and proven by a bank line), no bank line yet, nothing provable, nothing to do. Only the first is a to-do.' },
      { target: '[data-tour="recoupments-summary"], [data-tour="recoupments-header"]', title: 'Ready to upload', body: 'The dollar figure is what can be claimed now; Upload all sends it. Notes and the Audit link sit beside it.' },
      { target: '[data-tour="recoupments-filters"], [data-tour="recoupments-header"]', title: 'Filters', body: 'Search, artist, sort, then recoupable, UFR, payments and labels. Add to plan stages items for Planning.' },
    ],
  },
  {
    id: 'recoupments-planning', title: 'Recoupment planning', path: '/recoupments/planning', version: '2026-09-20',
    steps: [
      { target: '[data-tour="planning-header"]', title: 'Group, label, then mark UFR', body: 'Items staged from Recoupments land here. Group them by song or label and, when the claim is sent, Done marks them UFR in one go.' },
      { target: '[data-tour="planning-summary"], [data-tour="planning-header"]', title: 'The plan at a glance', body: 'How many items, how many groups, the total. Notes for the batch sit below.' },
      { target: '[data-tour="planning-body"], [data-tour="planning-header"]', title: 'By artist', body: 'One card per artist; open it to see songs and labels, select all, or split an item across artists. Nothing is written until Done.' },
    ],
  },
  {
    id: 'recoupments-audit', title: 'Recoupment audit', path: '/recoupments/audit', version: '2026-09-20',
    steps: [
      { target: '[data-tour="audit-header"]', title: 'Five checks', body: 'Money that should be claimed and has not been, and money claimed that cannot be shown. Recheck runs them again.' },
      { target: '[data-tour="audit-checks"], [data-tour="audit-header"]', title: 'Pick a check', body: 'Advances, the pile, double claims, no document, partial families. A clean check is greyed out; the others open below with the rows to fix.' },
    ],
  },
  // ─── Reports: Artist Spend family ───────────────────────────────────────
  {
    id: 'artist-budgets', title: 'Artist budgets', path: '/artist-budgets', version: '2026-09-20',
    steps: [
      { target: '[data-tour="budgets-header"]', title: 'Budget against actual', body: 'What each artist was budgeted, what is still owed, and what the ledger actually paid. New budget starts a sheet for an artist.' },
      { target: '[data-tour="budgets-tabs"], [data-tour="budgets-header"]', title: 'Budgets, Unlinked, Import', body: 'Budgets is the card grid; Unlinked is spend the app could not tie to a plan; Import sheet brings a spreadsheet in.' },
      { target: '[data-tour="budgets-search"], [data-tour="budgets-header"]', title: 'The sheet', body: 'Search and sort the cards; open one for the sheet — Advance and Total marketing typed, release budgets under marketing, and a Full breakdown by category.' },
    ],
  },
  {
    id: 'artist-campaigns', title: 'Campaigns', path: '/artist-campaigns', version: '2026-09-20',
    steps: [
      { target: '[data-tour="campaigns-header"]', title: 'Spend against campaigns', body: 'Every artist spend on the ledger reconciled against the marketing team\'s tracked campaigns. Catch up on campaigns opens the queue of spend nobody attributed.' },
      { target: '[data-tour="campaigns-search"], [data-tour="campaigns-header"]', title: 'Search, then the totals', body: 'Search an artist or song. Settled is bank-proven spend inside the date range; Committed is every open invoice regardless of date — the range binds only Settled.' },
      { target: '[data-tour="campaigns-summary"], [data-tour="campaigns-search"], [data-tour="campaigns-header"]', title: 'Gaps', body: 'Spend that names no artist is listed by category with Attribute it; the ad pool links to Allocate Ads. Dismissing an artist is triage, not deletion.' },
    ],
  },
  {
    id: 'ad-allocation', title: 'Allocate ads', path: '/bk/advertising', version: '2026-09-20',
    steps: [
      { target: '[data-tour="ads-header"]', title: 'Ad charges name nobody', body: 'Meta and other ad platforms bill the label, not an artist. Pick a month and put campaigns — and so artists — behind the money.' },
      { target: '[data-tour="ads-campaigns"], [data-tour="ads-header"]', title: 'Campaigns for the month', body: 'New campaign names an artist and a release; Import CSV brings the platform\'s export in for proportions. A CSV never supplies money — only how to split the real charges.' },
      { target: '[data-tour="ads-charges"], [data-tour="ads-header"]', title: 'The charges', body: 'Every bank charge for the month with its allocation. Apply writes the splits to the ledger as reviewed, recoupable rows — that is what makes them appear on Recoupments.' },
    ],
  },
  // ─── Hidden pages (not in the sidebar; reached by link) ─────────────────
  {
    id: 'financials', title: 'Financials', path: '/financials', version: '2026-09-20',
    steps: [
      { target: '[data-tour="financials-header"]', title: 'The executive spend view', body: 'Paid, unpaid and intake across every artist, song and category, on a commitment basis — unpaid invoices count. It will not tie to Reports, which is cash basis.' },
      { target: '[data-tour="financials-kpis"], [data-tour="financials-header"]', title: 'This week, month, year, pipeline', body: 'Four point-in-time figures; click one to see its rows. They ignore the range picker in the header.' },
      { target: '[data-tour="financials-filters"], [data-tour="financials-monthly"], [data-tour="financials-header"]', title: 'Filter, then read down', body: 'Artist, category and rep scope everything below: the weekly chart, aging, the cash forecast, the monthly rollup by artist, top spend, reps and category trends.' },
    ],
  },
  {
    id: 'recording-budgets', title: 'Recording budgets', path: '/budget', version: '2026-09-20',
    steps: [
      { target: '[data-tour="recording-budgets-header"]', title: 'Recording budgets and funds', body: 'Draft, approve and lock a recording budget, then track actual spend against it. New budget starts one; a fund is the same record with an advance instead.' },
      { target: '[data-tour="recording-budgets-list"], [data-tour="recording-budgets-search"], [data-tour="recording-budgets-header"]', title: 'The list', body: 'Search and filter by status: draft, approved, locked. Each row opens the sheet.' },
    ],
  },
  {
    id: 'salary', title: 'Salary', path: '/salary', version: '2026-09-20', roles: ['Admin', 'Superadmin'],
    steps: [
      { target: '[data-tour="salary-header"]', title: 'Monthly payroll', body: 'One month at a time: move between months, jump to this month, or open History for past payments.' },
      { target: '[data-tour="salary-summary"], [data-tour="salary-header"]', title: 'Totals', body: 'Total payroll, paid out, remaining, and how many people are paid this month.' },
      { target: '[data-tour="salary-body"], [data-tour="salary-header"]', title: 'By department', body: 'Each person is a row grouped by department: edit the amount, toggle paid, remove. Add Employee is at the bottom.' },
    ],
  },
  {
    id: 'analytics', title: 'Analytics', path: '/analytics', version: '2026-09-20', roles: ['Admin', 'Superadmin'],
    steps: [
      { target: '[data-tour="analytics-header"]', title: 'Who uses the app', body: 'Page views, active users, logins and actions, from the day the feature shipped, kept for 180 days.' },
      { target: '[data-tour="analytics-range"], [data-tour="analytics-header"]', title: 'Pick a window', body: 'The pills set the range for every card below: daily activity, most-used pages and most active people.' },
    ],
  },
  {
    id: 'activity', title: 'Activity', path: '/activity', version: '2026-09-20', roles: ['Admin', 'Superadmin'],
    steps: [
      { target: '[data-tour="activity-header"]', title: 'Who changed what', body: 'Every change anyone made, newest first, in plain words. Filter by person, action and date; reads are hidden unless you ask for them.' },
    ],
  },
]

// Every page tour with keys (lib/shortcuts.PAGE_KEYS) ends on them, anchored
// on the tour's own first target so the step always has somewhere to point.
// Bumped to 2026-09-22 so everyone sees those tours as updated (John's call).
const KEYS_VERSION = '2026-09-22'
for (const t of PAGE_TOURS) {
  if (!PAGE_KEYS[t.path] || t.match) continue
  t.steps.push({ target: t.steps[0].target, title: 'Keys on this page', body: `${keysSentence(t.path)}. Press ? any time for the list; g then a letter jumps to another page.` })
  if (t.version < KEYS_VERSION) t.version = KEYS_VERSION
}
// (Appended BEFORE the welcome walk is built from PAGE_TOURS, so the walk runs it too.)

// The welcome tour WALKS THE NAV: every group, every family, every visible
// tab, in sidebar order — EVERY step of each page's tour, in full, plus a
// step on each family's tab strip (John, 2026-09-20: the walk must finish a
// page before moving on). Skip this page / Skip family keep it survivable.
// Hidden pages (not drawn in the sidebar) have tours but are not in the walk.
// Steps carry `path`, `page`, `family`, `familyLabel`; the engine navigates,
// drops pages the person cannot open, and offers Skip this page / Skip family.
// Every step of a page's tour, stamped with the page it belongs to.
const stepsOf = (t, pth, extra) => (t ? t.steps.map((st) => ({ ...st, path: pth, page: t.title, ...(t.roles ? { roles: t.roles } : {}), ...extra })) : [])
function walkSteps() {
  const out = []
  for (const g of NAV_GROUPS) {
    for (const item of g.items) {
      if (item.tabbed || item.collapsible) {
        const kids = item.children.filter((c) => !c.hidden && !c.external)
        if (!kids.length) continue
        const fam = { family: item.key || item.label, familyLabel: item.label }
        const names = kids.map((c) => c.label).join(' · ')
        out.push({ path: kids[0].path, target: `[data-tour="family-tabs"][data-family="${item.key}"]`, title: `${item.label}: ${kids.length} tab${kids.length === 1 ? '' : 's'}`, body: `One sidebar row, several pages: ${names}. The tabs sit across the top; the walk visits each one.`, page: item.label, ...fam, ...(item.adminOnly ? { roles: ['Admin', 'Superadmin'] } : {}) })
        for (const c of kids) out.push(...stepsOf(PAGE_TOURS.find((t) => t.path === c.path && !t.match), c.path, { ...fam, ...(c.adminOnly ? { roles: ['Admin', 'Superadmin'] } : {}) }))
      } else if (!item.hidden && !item.external) {
        out.push(...stepsOf(PAGE_TOURS.find((t) => t.path === item.path && !t.match), item.path, item.adminOnly ? { roles: ['Admin', 'Superadmin'] } : {}))
      }
    }
  }
  return out
}
const WELCOME = {
  id: 'welcome', title: 'Welcome to the dashboard', path: '/', version: '2026-09-22', auto: 'first-signin', multipage: true,
  steps: [
    { path: '/', target: null, title: 'Welcome to Market Street', body: 'A walk through every page you can open, each one in full — fifteen minutes or so. Skip a page, a family, or the whole tour at any time; replay any page\'s part later from Walkthrough in the top bar.' },
    { path: '/', target: '[data-tour="sidebar"]', prepare: 'sidebar', title: 'Everything is in the sidebar', body: 'Five groups: General, Artists & releases, Money, Reports, Admin. A row with a chevron holds several pages; open it and they appear as tabs across the top. On a phone the ☰ button opens this menu.' },
    { path: '/', target: '[data-tour="search"]', title: 'Search jumps anywhere', body: 'Press / or ⌘K. Type a page, an artist, a vendor or an invoice number.' },
    { path: '/', target: null, title: 'The keyboard', body: 'Press g then a letter to jump to a page (g f is Flags, g a Approvals, g p Payments). On any list j and k move, Enter opens, e edits, x selects, f finds the filter box, n makes a new one. Press ? for the list on the page you are on.' },
    ...walkSteps(),
    { path: '/', target: '[data-tour="walkthrough"], [data-tour="help"]', title: 'That is the dashboard', body: 'Each page also has its own short tour the first time you open it. Replay any of them from Walkthrough in the top bar (the footprints on a phone), or press ? for shortcuts and tours.' },
  ],
}
export const TOURS = [WELCOME, ...PAGE_TOURS]
// Every visible nav page the walk expects a tour for (the fixture fails on a gap).
export const WALK_PATHS = NAV_GROUPS.flatMap((g) => g.items.flatMap((item) => (item.tabbed || item.collapsible) ? item.children.filter((c) => !c.hidden && !c.external).map((c) => c.path) : (!item.hidden && !item.external ? [item.path] : [])))

export const tourById = (id) => TOURS.find((t) => t.id === id) || null
// Which tour belongs to a pathname (a page tour, never the welcome tour).
export function tourForPath(pathname) {
  const hits = TOURS.filter((t) => t.id !== 'welcome' && (t.match ? t.match.test(pathname) : (t.path === pathname)))
  if (!hits.length) return null
  return hits.find((t) => t.match) || hits[0]
}
