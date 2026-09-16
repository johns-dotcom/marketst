import {
  AlertTriangle,
  Ban,
  Banknote,
  BarChart2,
  BookOpen,
  Briefcase,
  Building2,
  CalendarDays,
  CheckSquare,
  ClipboardList,
  Contact,
  CreditCard,
  Disc3,
  FileBarChart,
  FileSignature,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Landmark,
  Layers,
  LayoutDashboard,
  Library,
  LineChart,
  Link2,
  Megaphone,
  MessagesSquare,
  Music,
  Package,
  PiggyBank,
  PlusCircle,
  Receipt,
  RefreshCw,
  Repeat,
  Scale,
  ScrollText,
  Target,
  SearchCheck,
  Send,
  Settings,
  ShieldCheck,
  TrendingUp,
  Upload,
  UserCheck,
  Users,
  Wallet,
  Wrench,
} from 'lucide-react'

// ── The application's navigation. ONE definition. ───────────────────────────
//
// This lived inside Layout.jsx while Settings.jsx kept a parallel ALL_PAGES
// list for the My Nav and Permissions editors. Two hand-maintained copies of
// the same thing drift, and they had:
//
//   • /admin/vendor-preview was in the sidebar but absent from Settings, so it
//     was the one page in the app you could not hide or grant
//   • the Bookkeeping group listed the same 14 pages in a different ORDER, so
//     My Nav's checkboxes didn't follow the sidebar you were configuring
//   • three labels disagreed outright — 'Pending' vs 'Pending Contracts',
//     'Reports' vs 'Reports (P&L / BS)', 'Activity' vs 'Activity History'
//
// Adding a page now means adding it HERE and nowhere else. See CLAUDE.md's
// "Adding a New Page" checklist, which this collapses two steps of.
//
// Shape notes:
//   label: null      the untitled group pinned to the top of the sidebar.
//                    Surfaces as 'General' in Settings via NAV_PAGES.
//   sysAdminOnly     the group renders only for a system admin. Declarative so
//                    a consumer that isn't the sidebar can still enumerate it.
//   collapsible      a nested disclosure in the sidebar; its `children` are
//                    ordinary pages and are flattened into NAV_PAGES.
//   external         opens in a new tab; still a page for permission purposes.
//
// Deliberately NOT here: the Approvals badge count. It is per-request state, so
// Layout injects it at render rather than this becoming a live data dependency.
export const NAV_GROUPS = [
    {
      label: null,
      items: [
        { path: '/',           label: 'Dashboard', icon: LayoutDashboard, synonyms: 'home overview' },
        { path: '/my-work',    label: 'My Work',   icon: Briefcase, synonyms: 'assigned to me tasks queue' },
        // Always reachable: '/messages' is on the BASE_WHITELIST in
        // lib/pageAccess.js and its server mirror, so every role can open it.
        // It is listed here anyway — that is what puts it in Settings' My Nav,
        // where a user may HIDE it. Hidden is not denied.
        { path: '/messages',   label: 'Messages',  icon: MessagesSquare, synonyms: 'chat dm slack team channel talk' },
        { path: '/calendar',   label: 'Calendar',  icon: CalendarDays, synonyms: 'schedule dates' },
        // Top-level, not under Releases: the hub now spans the catalog, the
        // ledger, and the bank, so it doesn't belong to any one group.
        { path: '/flags',      label: 'Flags',     icon: AlertTriangle, synonyms: 'duplicates problems issues review' },
      ]
    },
    {
      label: 'Artists',
      items: [
        { path: '/artists', label: 'Roster',        icon: Users, synonyms: 'artist list roster' },
        { path: '/deals',   label: 'Deal Pipeline', icon: TrendingUp, synonyms: 'deals prospects signing pipeline' },
      ]
    },
    {
      label: 'Releases',
      items: [
        { path: '/releases',   label: 'Release Tracker', icon: Music, synonyms: 'release schedule dsp drop' },
        { path: '/catalog',    label: 'Catalog',    icon: Library, synonyms: 'songs masters tracks catalog' },
      ]
    },
    {
      label: 'Contracts',
      items: [
        { path: '/contracts',         label: 'Contracts',       icon: FileText, synonyms: 'agreement signed contract' },
        { path: '/pending-contracts', label: 'Pending',         icon: ClipboardList, synonyms: 'unsigned awaiting signature pending' },
        { path: '/renewals',          label: 'Renewals',        icon: RefreshCw, synonyms: 'expiring renew option' },
        { path: '/contracts/create',  label: 'Create Contract', icon: PlusCircle, synonyms: 'new contract draft' },
        { path: '/create-nda',        label: 'Create NDA',      icon: FileText, synonyms: 'nda non-disclosure new' },
        { path: '/create-label-waiver', label: 'Create Label Waiver', icon: FileText, synonyms: 'waiver label release new' },
        { path: '/create-artist-clearance', label: 'Create Artist Clearance', icon: FileSpreadsheet, synonyms: 'clearance sample feature new' },
      ]
    },
    {
      // Day-to-day money-in / money-out work. Ordered by daily-use
      // frequency: pending review → outgoing payments → master ledger →
      // add → reference data → rare tools.
      label: 'Bookkeeping',
      items: [
        { path: '/bk/approvals', label: 'Approvals',     icon: CheckSquare, synonyms: 'review pending submitted vendor queue' },
        { path: '/bk/payments',  label: 'Payments',      icon: CreditCard, synonyms: 'pay due outgoing wire ach rush' },
        { path: '/bk/ledger',    label: 'Ledger',        icon: BookOpen, synonyms: 'expenses master register search lookup' },
        {
          // Four rows, one job. John, 2026-09-02: "i want to combine the bank
          // matching and bank ledger pages and make it more like quickbooks …
          // it just feels messy right now."
          //
          // They are four views of ONE bank month — the files it arrived in,
          // the queue of lines still to answer, the register of the ones that
          // are answered, and the standing rules that keep the queue finite —
          // and they were scattered across the group: Bank Ledger at slot 4,
          // Statements and Bank Matching at 9 and 10, Rules at 11. Each carried
          // its own month selector and its own summary of the same month.
          // QuickBooks calls this surface Banking; so does this.
          //
          // NOT ONE URL MOVED, and that is not tidiness — it is the constraint.
          // Page permissions are stored BY PATH, and lib/pageAccess.js already
          // carries two carve-outs for these very pages (/bk/bank-matching from
          // /bk/statements at :91, /bk/bank-ledger from /bk/ledger at :99).
          // Folding four paths into one route would need four more, forever,
          // plus dead bookmarks — and three live deep links point at these
          // paths by name (BkStatements' openStatement, and BkLedger's
          // Statement and Bank-line cells).
          //
          // So only the LABELS changed, per CLAUDE.md's rename rule. The old
          // ones live on in `synonyms` — ⌘K and the permissions editor match on
          // label + path + synonyms, and '/bk/bank-matching' does not contain
          // the string "bank matching" (hyphen, not space), so without that a
          // year of muscle memory stops finding the page.
          //
          // Sits at slot 4, where Bank Ledger was, rather than down at 9 where
          // three of the four lived: the group is ordered by daily-use
          // frequency and the family's first tab is the review queue. The old
          // comment here argued the bank ledger belongs beside the ledger it
          // was split from; the family inherits that and brings its three
          // siblings up rather than leaving one register split across two ends
          // of the group.
          //
          // /bk/ledger — the INVOICED half — deliberately stays out. It is the
          // same component (<BkLedger bank /> vs <BkLedger />) but a different
          // question, and including it would make "Categorized" mean two things.
          tabbed: true,
          key: 'banking',
          label: 'Banking',
          icon: Landmark,
          children: [
            { path: '/bk/bank-matching', label: 'For review',  icon: Link2, synonyms: 'bank matching for review match reconcile transactions unmatched book' },
            { path: '/bk/bank-ledger',   label: 'Categorized', icon: Landmark, synonyms: 'bank ledger categorized booked bank rows nobody invoiced statement entries' },
            { path: '/bk/statements',    label: 'Statements',  icon: FileText, synonyms: 'pdf upload bank statement month paypal' },
            { path: '/bk/rules',         label: 'Rules',       icon: Ban, synonyms: 'upload rules ignore skip standing decisions matching rules' },
          ],
        },
        { path: '/bk/add',       label: 'Add Invoice',   icon: PlusCircle, synonyms: 'add invoice expense ap payable new bill' },
        { path: '/create-invoice', label: 'Create Invoice', icon: Receipt, synonyms: 'create invoice ar receivable outgoing charge bill a client' },
        {
          // Vendors and the 1099 run, behind one row. They are the same subject
          // from two angles — who we pay, and which of them the IRS needs a form
          // about — and 1099 Filing reads every W-9 the directory collects.
          //
          // NEITHER PATH MOVED. The 1099 page keeps its own route, which is the
          // point of doing this with a tab family rather than folding it into the
          // directory's own ?tab= strip: permissions are stored by path, so a
          // grant on /bk/vendors admits the directory and NOT the tax data. That
          // is the right default for a page carrying TINs and reportable totals,
          // and it is a distinction the query-param version could not express.
          //
          // The cost, chosen deliberately: two tab strips on the directory — this
          // family's bar above the page's own five worklists.
          tabbed: true,
          key: 'vendors',
          label: 'Vendors',
          icon: Building2,
          children: [
            { path: '/bk/vendors', label: 'Directory',    icon: Building2, synonyms: 'payee supplier w9 w8 directory contact' },
            { path: '/bk/1099',    label: '1099 Filing',  icon: FileText, synonyms: 'tax 1099 nec misc tin ein ssn w9 filing irs 1096 contractor' },
          ],
        },
        // Money the marketing team pays creators with no invoice. Its own page
        // because a creator has a PayPal handle and socials, not a W9 and
        // payment terms — and because the marketing team can be granted this
        // path without the rest of the bookkeeping surface.
        { path: '/bk/creators',  label: 'Creator Payments', icon: Users, synonyms: 'creator influencer paypal no invoice small payments socials' },
        // Statements, Bank Matching and Upload Rules used to sit here as three
        // separate rows. They are tabs of the Banking family above now — same
        // paths, same permissions, one row. See the comment there.
        { path: '/bk/invoices',  label: 'Invoices View', icon: Receipt, synonyms: 'invoice list documents files view all' },
        {
          // Four ways to put a file into the app, behind one row and one tab
          // bar. Every path is exactly where it has always been — the tab shell
          // changes the chrome, never the URL, so no bookmark and no stored
          // permission row is affected.
          tabbed: true,
          key: 'import',
          label: 'Import',
          icon: Upload,
          children: [
            { path: '/bk/bulk-upload',   label: 'Invoices',    icon: Upload, synonyms: 'many invoices at once bulk upload batch' },
            { path: '/bk/bulk-reupload', label: 'Re-upload',   icon: Upload, synonyms: 'replace files batch reupload' },
            { path: '/import',           label: 'QuickBooks',  icon: Upload, synonyms: 'quickbooks import qbo sync qb' },
            { path: '/import/master-sheet', label: 'Master sheet', icon: FileSpreadsheet, adminOnly: true, synonyms: 'master sheet catalog releases spreadsheet import' },
          ]
        },
        {
          // Less-frequent actions — collapsed by default. Add
          // Reimbursement is the most-used here so it leads.
          collapsible: true,
          key: 'bk-more',
          label: 'More',
          icon: FolderOpen,
          children: [
            { path: '/bk/reimburse',     label: 'Add Reimbursement', icon: PlusCircle, synonyms: 'expense report reimburse staff' },
            // "Ledger Matching" was the wrong name: it reads as the bank
            // statement ↔ ledger matcher, which lives on /bk/bank-matching.
            // This page diffs the external BOOKKEEPER's spreadsheet against our
            // ledger. The PATH deliberately stays — page permissions are stored
            // by path, so renaming it silently revokes the grant for everyone
            // holding it.
            { path: '/bk/ledger-matching', label: 'Bookkeeper Reconcile', icon: FileSpreadsheet, synonyms: 'accountant spreadsheet diff compare' },
          ]
        },
      ]
    },
    {
      // Read-and-analyze surfaces. Split from Bookkeeping so admins
      // reviewing a P&L don't have to scan past entry actions to find it.
      label: 'Reports',
      items: [
        { path: '/financials',    label: 'Financials',     icon: BarChart2, synonyms: 'balance sheet cash month' },
        { path: '/reports',       label: 'Reports',        icon: FileBarChart, synonyms: 'p&l pnl profit loss income statement export' },
        { path: '/budget',        label: 'Recording Budgets', icon: FileText, synonyms: 'recording budget studio producer template' },
        {
          // One subject behind one row and one tab bar. Same three URLs as
          // always — /recoupments, /recoupments/planning, /recoupments/audit.
          //
          // /recoupments/2025 is deliberately NOT here. It is routed, orphaned,
          // and staying that way.
          tabbed: true,
          key: 'recoupments',
          label: 'Recoupments',
          icon: PiggyBank,
          children: [
            { path: '/recoupments',          label: 'Overview', icon: PiggyBank, synonyms: 'recoup ufr artist advance claim recoupments' },
            { path: '/recoupments/planning', label: 'Planning', icon: FolderOpen, synonyms: 'stage plan recoup batch planning' },
            { path: '/recoupments/audit',    label: 'Audit',    icon: SearchCheck, synonyms: 'advances over-claim guard check audit' },
          ]
        },
        { path: '/artist-budgets', label: 'Artist Budgets', icon: Scale, synonyms: 'artist budget sheet spend variance committed campaign planned marketing spend sheet import xlsx' },
        { path: '/artist-campaigns', label: 'Artist Campaigns', icon: Megaphone, synonyms: 'marketing campaign promo spend per song' },
        { path: '/bk/advertising', label: 'Allocate Ads', icon: Target, synonyms: 'advertising facebook meta ads allocate attribute ad spend pool campaign' },
        { path: '/salary',        label: 'Salary',         icon: Wallet, synonyms: 'payroll compensation wages salary' },
        { path: '/bk/bulk-deals', label: 'Bulk Deals',     icon: Package, synonyms: 'mark deals batch recoupable' },
      ]
    },
    {
      label: 'Team',
      items: [
        { path: '/team',     label: 'Members',  icon: UserCheck, synonyms: 'staff people users team' },
        { path: '/settings', label: 'Settings', icon: Settings, synonyms: 'preferences theme my nav permissions' },
      ]
    },
    {
      sysAdminOnly: true,
      label: 'System',
      items: [
        { path: '/admin',    label: 'Admin Docs',  icon: ShieldCheck, synonyms: 'documentation admin runbook' },
        { path: '/activity', label: 'Activity',    icon: ScrollText, synonyms: 'audit log history who changed' },
        { path: '/analytics', label: 'Analytics',  icon: BarChart2, synonyms: 'usage pageviews logins' },
        { path: '/legal',    label: 'Legal',       icon: Scale, synonyms: 'terms privacy legal' },
        // ONE way in. There were two rows here, a character apart in a 200px
        // rail — "Vendor Form" and "Vendor Form (sandbox)" — and the first one
        // WROTE: pressing Submit on it created a real approval, uploaded a real
        // file and could email people. An admin opening the form to look at it
        // should not be able to do that by pressing the obvious button, and the
        // two labels are not far enough apart to protect anyone.
        //
        // /admin/vendor-preview is gone (App.jsx redirects it here so old links
        // and bookmarks land somewhere true). To watch a submission land for
        // real, use the live form itself.
        //
        // Dedicated path rather than a query param, as before: the sandbox
        // signal can never be lost by middleware / cache / URL rewriting.
        // Opens in a new tab so the admin's session stays open.
        { path: '/admin/vendor-lab', label: 'Vendor Form (sandbox)', icon: Send, external: true, synonyms: 'vendor form sandbox lab test preview' },
      ]
    },
  ]

// Flattened for Settings — the My Nav toggles and the Permissions editor both
// want one page per row, with the group only as a heading. Collapsible children
// are pulled up: a nested sidebar item is still a page you can grant or hide.
//
// Order is preserved exactly, which is the point — the checkbox list reads in
// the same sequence as the sidebar it configures.
export const NAV_PAGES = NAV_GROUPS.flatMap((g) => {
  const group = g.label || 'General'
  // `synonyms` rides along for the ⌘K palette, which matches label + path +
  // synonyms. Dropping it here would make every page findable only by the exact
  // word already printed in the sidebar — which is no help to the person who
  // does not know what the sidebar calls it.
  const row = (i) => ({ path: i.path, label: i.label, group, synonyms: i.synonyms || '' })
  // BOTH container kinds flatten. `tabbed` children are hidden from the rail but
  // they are still PAGES: Settings renders its permission checkboxes from this
  // list, so a child missing here is a page nobody can ever be granted, and ⌘K
  // would stop finding it. Hiding a row and removing a page are different acts.
  return g.items.flatMap((item) => (
    item.collapsible || item.tabbed ? item.children.map(row) : [row(item)]
  ))
})

/**
 * The tab family that owns a path, or null.
 *
 * ONE definition, read by both consumers: Layout draws the sidebar row from it,
 * TabbedShell draws the tab bar from it. Two lists would drift the first time a
 * tab is added — the failure this file was created to end.
 */
export function tabFamilyFor(path) {
  for (const g of NAV_GROUPS) {
    for (const item of g.items) {
      if (item.tabbed && item.children.some((c) => c.path === path)) return item
    }
  }
  return null
}

/** A family by its `key`, for a wrapper that names one explicitly. */
export function tabFamily(key) {
  for (const g of NAV_GROUPS) {
    for (const item of g.items) if (item.tabbed && item.key === key) return item
  }
  return null
}

// Deliberately NOT exported as a breadcrumb/title source.
//
// Layout keeps its own PAGE_LABELS and it is NOT drift — the page titles are
// intentionally longer than the sidebar's compact labels ('Artist Roster' vs
// 'Roster', 'QuickBooks Import' vs 'QB Import', 'Team' vs 'Members'), and it
// covers routes that have no nav entry at all (/duplicates, /bk/bank-vendors,
// /bk/vendor-flags). Wiring titles to these labels would abbreviate every page
// header to fit a 200px rail. Two lists here are two different jobs.
