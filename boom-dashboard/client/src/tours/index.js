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
export const TOURS = [
  {
    // The welcome tour WALKS THE PAGES: each step names its `path`; the engine
    // navigates there, waits for the anchor, and skips pages this person cannot
    // open (canView). `target: null` is a centered card with no spotlight.
    id: 'welcome', title: 'Welcome to the dashboard', path: '/', version: '2026-09-19', auto: 'first-signin', multipage: true,
    steps: [
      { path: '/', target: null, title: 'Welcome to Market Street', body: 'A short walk through every page you can open — about three minutes. You can skip a page, or the whole tour, at any time, and replay it later from Walkthrough in the top bar.' },
      { path: '/', target: '[data-tour="sidebar"]', title: 'Everything is in the sidebar', body: 'Five groups: General, Artists & releases, Money, Reports, Admin. A row with a chevron holds several pages; open it and they appear as tabs across the top.' },
      { path: '/', target: '[data-tour="home-loop"]', title: 'Home is what needs doing', body: 'Approvals waiting, payments due, bank lines to review, releases coming, artists mid-onboarding, your tasks. Each tile opens the page that resolves it; when all is clear this collapses to one line.' },
      { path: '/', target: '[data-tour="search"]', title: 'Search jumps anywhere', body: 'Press / or ⌘K. Type a page, an artist, a vendor or an invoice number.' },
      { path: '/my-work', target: '[data-tour="my-work-list"]', title: 'My Work', body: 'Your tasks by when they are due, editable in place; the dates that involve you this week; and, on the right, only the things you can unblock.' },
      { path: '/artists', target: '[data-tour="artists-header"]', title: 'Artists', body: 'The roster. Each profile is the hub for that artist: releases, contracts, documents, budget, recoupments, campaigns, and the onboarding checklist after a signing.' },
      { path: '/releases', target: '[data-tour="releases-list"]', title: 'Releases', body: 'Every release with a date and its checklist. Click a row to expand it. Keys 1–7 switch its tabs.' },
      { path: '/deals', target: '[data-tour="deal-board"]', title: 'Deals', body: 'Scouting to Signed. Type the terms on the deal at Offer; moving it to Signed adds the artist, creates the advance invoice, marks the calendar and prefills the contract.' },
      { path: '/contracts', target: '[data-tour="contracts-header"]', title: 'Contracts', body: 'Agreements on file with terms and expiry. Expiring ones surface under Renewals and on the calendar.' },
      { path: '/bk/approvals', target: '[data-tour="approvals"]', title: 'Approvals', body: 'Invoices vendors submitted, with what the AI read off the document beside what they typed. Confirm, answer the three questions, approve or reject.' },
      { path: '/bk/payments', target: '[data-tour="payments"]', title: 'Payments', body: 'Approved invoices by priority. Mark paid, attach the proof, send the confirmation from the mailbox that owns payments.' },
      { path: '/calendar', target: '[data-tour="calendar-grid"]', title: 'Calendar', body: 'Release dates, task deadlines, payment due dates, renewals and signings, each linking to its page. The legend is the filter.' },
      { path: '/brand', target: '[data-brand-drop]', title: 'Brand', body: 'The label\'s logos and photos. Drop files in; anyone can download them.' },
      { path: '/team', target: '[data-directory]', title: 'People', body: 'Everyone with an account: role, department, what they can open, last sign-in. Add a person and hand them a one-time link.' },
      { path: '/settings', target: '[data-settings-shell] aside', title: 'Settings', body: 'Yours first — profile, sign-in, notifications, your mailbox, theme, sidebar. Then the label\'s: people, the Label record, integrations and mail.' },
      { path: '/', target: '[data-tour="help"]', title: 'That is the dashboard', body: 'Each page also has its own short tour the first time you open it. Replay any of them from Walkthrough in the top bar, or press ? for shortcuts and tours.' },
    ],
  },
  {
    id: 'home', title: 'Home', path: '/', version: '2026-09-19',
    steps: [
      { target: '[data-tour="home-loop"]', title: 'The loop', body: 'Invoices arrive, get approved, get paid, the bank statement proves it, reports read from that. One tile per step.' },
      { target: '[data-quick-actions]', title: 'Start something', body: 'Add an invoice, add a release, open a new deal. Only the actions for pages you can open.' },
      { target: '[data-week]', title: 'The next seven days', body: 'From the team calendar: release dates, payment due dates, task deadlines, renewals. Each links to its page.' },
      { target: '[data-activity]', title: 'What the team did', body: "Everyone else's recent changes, newest first, with any alerts on top." },
    ],
  },
  {
    id: 'releases', title: 'Releases', path: '/releases', version: '2026-09-19',
    steps: [
      { target: '[data-tour="releases-header"]', title: 'The pipeline', body: 'Every release with a date, and its checklist. Add release opens a form; if you arrived from a saved contract the artist is already filled in.' },
      { target: '[data-tour="releases-list"]', title: 'One row per release', body: 'Click a row to expand it: checklist, metadata, DSP submissions, budget, activity, comments. Keys 1–7 switch tabs; j and k move between releases.' },
    ],
  },
  {
    id: 'deals', title: 'Deals', path: '/deals', version: '2026-09-19',
    steps: [
      { target: '[data-tour="deal-board"]', title: 'Scouting to Signed', body: "Drag a card between stages. Type the terms and the artist's contact on the deal at Offer — the contract, the roster row and the advance invoice all read from them." },
      { target: '[data-tour="deals-header"]', title: 'Signed does the work', body: 'Moving a deal to Signed adds the artist to the roster, creates the advance as an invoice due in 30 days, marks the calendar, and hands you the contract form prefilled.' },
    ],
  },
  {
    id: 'contracts', title: 'Contracts', path: '/contracts', version: '2026-09-19',
    steps: [
      { target: '[data-tour="contracts-header"]', title: 'Contracts on file', body: 'Active agreements with their terms and expiry. Expiring ones surface under Renewals and on the calendar. Saving a contract offers the next step: the release.' },
    ],
  },
  {
    id: 'artists', title: 'Artists', path: '/artists', version: '2026-09-19',
    steps: [
      { target: '[data-tour="artists-header"]', title: 'The roster', body: 'Everyone signed to the label. Add artist creates a profile by hand; a deal moved to Signed does it for you.' },
      { target: '[data-tour="artist-card"]', title: 'Open a profile', body: 'The profile is the hub: releases, contracts, documents, budget, recoupments, campaigns, and the onboarding checklist for a newly signed artist.' },
    ],
  },
  {
    id: 'artist-profile', title: "An artist's profile", path: '/artists', version: '2026-09-19', match: /^\/artists\/\d+/,
    steps: [
      { target: '[data-onboarding]', title: 'Onboarding', body: 'For an artist signed through the pipeline: contract on file, payment details and W-9, advance paid, budget set, first release. It ticks itself from the data and collapses when complete.' },
      { target: '[data-tour="artist-tabs"]', title: 'Every side of the artist', body: 'Releases and contracts, then the money: Budget, Recoupments and Campaigns, each read-only here with a link to its full page.' },
    ],
  },
  {
    id: 'approvals', title: 'Approvals', path: '/bk/approvals', version: '2026-09-19',
    steps: [
      { target: '[data-tour="approvals"]', title: 'Invoices waiting', body: 'Vendors submit at /submit; each arrives here with what the AI read off the document beside what the vendor typed. Confirm artist, song, amount and category, answer the three questions, approve or reject.' },
    ],
  },
  {
    id: 'payments', title: 'Payments', path: '/bk/payments', version: '2026-09-19',
    steps: [
      { target: '[data-tour="payments"]', title: 'What to pay next', body: 'Approved invoices ordered by priority: rush and overdue first. The stat cards are the filters. Mark paid, attach the proof, send the confirmation — from the mailbox that owns payments.' },
    ],
  },
  {
    id: 'calendar', title: 'Calendar', path: '/calendar', version: '2026-09-19',
    steps: [
      { target: '[data-tour="calendar-grid"]', title: 'The team calendar', body: 'Release dates, task deadlines, payment due dates, contract renewals, signings. Click a day to see its items; each links to its page.' },
      { target: '[data-legend]', title: 'The legend is the filter', body: 'Click a row to hide or show that kind of date. A locked row is a source your account cannot open.' },
    ],
  },
  {
    id: 'people', title: 'People', path: '/team', version: '2026-09-19',
    steps: [
      { target: '[data-directory]', title: 'Everyone with an account', body: 'Role, department, what they can open, last sign-in, open tasks. Open a person to change their access.' },
      { target: '[data-invite]', title: 'Adding a person', body: 'Name, email, department. The department picks a starting preset of pages; presets add up for someone with two jobs. You get a one-time link to send them.' },
    ],
  },
  {
    id: 'settings', title: 'Settings', path: '/settings', version: '2026-09-19',
    steps: [
      { target: '[data-settings-shell] aside', title: 'Two halves', body: "My settings is yours: profile, sign-in, notifications, your own mailbox, theme, sidebar. Label settings is the label's: people, the Label record, integrations and mail, activity, archive." },
    ],
  },
  {
    id: 'brand', title: 'Brand', path: '/brand', version: '2026-09-19',
    steps: [
      { target: '[data-brand-drop]', title: 'Logos and photos', body: 'Drop files here, filed as logo, photo or other. Vector files download rather than preview.' },
      { target: '[data-brand-filter]', title: 'Find and download', body: 'Filter by kind; every tile has a Download link. Remove your own uploads, or anything if you are an admin.' },
    ],
  },
  {
    id: 'my-work', title: 'My Work', path: '/my-work', version: '2026-09-19',
    steps: [
      { target: '[data-tour="my-work-add"]', title: 'Add a task', body: 'Type it and press Enter. @ assigns it to a teammate; the chips set priority, category and due date. Press n anywhere on this page to jump here.' },
      { target: '[data-tour="my-work-list"]', title: 'Your list, by when', body: 'Overdue, today, this week, later, no date. Click a row to edit it in place — status, priority, due date, notes, who it is for. The circle marks it done.' },
      { target: '[data-tour="my-work-week"]', title: 'This week, mine', body: 'From the team calendar, kept to what involves you: your task deadlines, your releases, and the money dates you can open.' },
      { target: '[data-tour="my-work-waiting"]', title: 'Waiting on you', body: 'Only things you can unblock: invoices for your approval, mentions, invites you sent that nobody used, the statement cutoff. It disappears when there is nothing.' },
    ],
  },
]

export const tourById = (id) => TOURS.find((t) => t.id === id) || null
// Which tour belongs to a pathname (a page tour, never the welcome tour).
export function tourForPath(pathname) {
  const hits = TOURS.filter((t) => t.id !== 'welcome' && (t.match ? t.match.test(pathname) : (t.path === pathname)))
  if (!hits.length) return null
  return hits.find((t) => t.match) || hits[0]
}
