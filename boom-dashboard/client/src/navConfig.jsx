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
    // ── Market Street regroup, 2026-09-18 ──────────────────────────────────
    //
    // 43 sidebar rows became 16. NOT ONE PATH MOVED: every consolidation is a
    // `tabbed` family (one sidebar row, the tabs live in the page chrome), which
    // is the mechanism Banking / Vendors / Import / Recoupments already used.
    // Page permissions are stored BY PATH, so this is the only shape of
    // consolidation that costs nothing in pageAccess.js carve-outs.
    //
    //   hidden: true   the page stays in NAV_PAGES — grantable in Settings,
    //                  findable in ⌘K, still a "known page" for the permission
    //                  walk — but the sidebar does not draw it. Hiding a row
    //                  and removing a page are different acts; this is the
    //                  first. Seven pages are hidden here because nothing at
    //                  Market Street produces their data yet (see the plan:
    //                  Financials, Recording Budgets, Salary, Bulk Deals,
    //                  Invoices View, Bookkeeper Reconcile, Analytics).
    //
    // Boom's nav is untouched by this; it is a Market Street decision.
    {
      label: null,
      items: [
        { path: '/',           label: 'Home',      icon: LayoutDashboard, synonyms: 'home dashboard overview' },
        { path: '/my-work',    label: 'My Work',   icon: Briefcase, synonyms: 'assigned to me tasks queue' },
        // Always reachable: '/messages' is on the BASE_WHITELIST in
        // lib/pageAccess.js and its server mirror, so every role can open it.
        // Listed anyway — that is what puts it in Settings' My Nav, where a
        // user may HIDE it. Hidden is not denied.
        { path: '/messages',   label: 'Messages',  icon: MessagesSquare, synonyms: 'chat dm slack team channel talk' },
        { path: '/calendar',   label: 'Calendar',  icon: CalendarDays, synonyms: 'schedule dates' },
        // Top-level: the hub spans the catalog, the ledger and the bank, so it
        // belongs to no group. Money-shaped sections are role-gated
        // server-side in routes/flags.js; the row itself is for everyone.
        { path: '/flags',      label: 'Flags',     icon: AlertTriangle, synonyms: 'duplicates problems issues review' },
      ]
    },
    {
      label: 'Artists & releases',
      items: [
        { path: '/artists', label: 'Roster', icon: Users, synonyms: 'artist list roster' },
        {
          // Same records, before and after release. GET /releases defaults to
          // the pipeline and takes in_catalog=any for the archive.
          tabbed: true,
          key: 'releases',
          label: 'Releases',
          icon: Music,
          children: [
            { path: '/releases', label: 'Pipeline', icon: Music, synonyms: 'release tracker schedule dsp drop upcoming pipeline' },
            { path: '/catalog',  label: 'Catalog',  icon: Library, synonyms: 'songs masters tracks catalog streams' },
          ],
        },
        {
          // Left to right is the lifecycle: a deal becomes a contract, a
          // contract goes out unsigned, a signed one comes up for renewal.
          tabbed: true,
          key: 'contracts',
          label: 'Contracts',
          icon: FileText,
          children: [
            { path: '/deals',             label: 'Deals',    icon: TrendingUp, synonyms: 'deals prospects signing pipeline deal pipeline' },
            { path: '/contracts',         label: 'Active',   icon: FileText, synonyms: 'agreement signed contract active' },
            { path: '/pending-contracts', label: 'Pending',  icon: ClipboardList, synonyms: 'unsigned awaiting signature pending' },
            { path: '/renewals',          label: 'Renewals', icon: RefreshCw, synonyms: 'expiring renew option' },
          ],
        },
        {
          // Tools that produce a PDF, not records. Create Invoice issues an
          // invoice TO a client (receivable) — a document, not a payable — which
          // is why it sits here and not under Money.
          tabbed: true,
          key: 'documents',
          label: 'Documents',
          icon: FileSignature,
          children: [
            { path: '/contracts/create',        label: 'Contract',     icon: PlusCircle, synonyms: 'new contract draft create contract' },
            { path: '/create-nda',              label: 'NDA',          icon: FileText, synonyms: 'nda non-disclosure new create' },
            { path: '/create-label-waiver',     label: 'Label Waiver', icon: FileText, synonyms: 'waiver label release new create' },
            { path: '/create-artist-clearance', label: 'Clearance',    icon: FileSpreadsheet, synonyms: 'clearance sample feature new create artist clearance' },
            { path: '/create-invoice',          label: 'Invoice',      icon: Receipt, synonyms: 'create invoice ar receivable outgoing charge bill a client' },
          ],
        },
      ]
    },
    {
      // Money out. Two sides of one ledger: what we owe (Invoices) and what the
      // bank says left (Bank), plus who we pay (Vendors).
      label: 'Money',
      items: [
        {
          // One payable, four stages, and the small no-invoice payments to
          // creators that follow the same path. Add is the manual entry
          // (invoice or reimbursement — the page has both modes).
          tabbed: true,
          key: 'invoices',
          label: 'Invoices',
          icon: CheckSquare,
          children: [
            { path: '/bk/approvals', label: 'Approvals', icon: CheckSquare, synonyms: 'review pending submitted vendor queue' },
            { path: '/bk/payments',  label: 'Payments',  icon: CreditCard, synonyms: 'pay due outgoing wire ach rush' },
            { path: '/bk/ledger',    label: 'Ledger',    icon: BookOpen, synonyms: 'expenses master register search lookup' },
            { path: '/bk/creators',  label: 'Creators',  icon: Users, synonyms: 'creator influencer paypal no invoice small payments socials' },
            { path: '/bk/add',       label: 'Add',       icon: PlusCircle, synonyms: 'add invoice expense ap payable new bill manual entry' },
          ],
        },
        {
          // Four views of ONE bank month — the files it arrived in, the queue
          // of lines still to answer, the register of the answered ones, and
          // the standing rules that keep the queue finite. John, 2026-09-02:
          // "make it more like quickbooks". Key stays `banking`: BankShell and
          // the bankshell harness name it.
          tabbed: true,
          key: 'banking',
          label: 'Bank',
          icon: Landmark,
          children: [
            { path: '/bk/bank-matching', label: 'For review',  icon: Link2, synonyms: 'bank matching for review match reconcile transactions unmatched book' },
            { path: '/bk/bank-ledger',   label: 'Categorized', icon: Landmark, synonyms: 'bank ledger categorized booked bank rows nobody invoiced statement entries' },
            { path: '/bk/statements',    label: 'Statements',  icon: FileText, synonyms: 'pdf upload bank statement month paypal' },
            { path: '/bk/rules',         label: 'Rules',       icon: Ban, synonyms: 'upload rules ignore skip standing decisions matching rules' },
          ],
        },
        {
          tabbed: true,
          key: 'vendors',
          label: 'Vendors',
          icon: Building2,
          children: [
            { path: '/bk/vendors', label: 'Directory',   icon: Building2, synonyms: 'payee supplier w9 w8 directory contact' },
            { path: '/bk/1099',    label: '1099 Filing', icon: FileText, synonyms: 'tax 1099 nec misc tin ein ssn w9 filing irs 1096 contractor' },
          ],
        },
        // Hidden — routed and grantable, not drawn. See the header comment.
        { path: '/bk/reimburse',       label: 'Add Reimbursement',    icon: PlusCircle, hidden: true, synonyms: 'expense report reimburse staff' },
        { path: '/bk/invoices',        label: 'Invoices View',        icon: Receipt, hidden: true, synonyms: 'invoice list documents files view all' },
        { path: '/bk/bulk-deals',      label: 'Bulk Deals',           icon: Package, hidden: true, synonyms: 'mark deals batch recoupable' },
        { path: '/bk/ledger-matching', label: 'Bookkeeper Reconcile', icon: FileSpreadsheet, hidden: true, synonyms: 'accountant spreadsheet diff compare' },
      ]
    },
    {
      label: 'Reports',
      items: [
        // Cash basis, tied to the bank. Financials (invoice basis, includes
        // unpaid) is hidden below; Reports' own basis note links to it.
        { path: '/reports', label: 'Reports', icon: FileBarChart, synonyms: 'p&l pnl profit loss income statement balance sheet export' },
        {
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
        {
          // Three views of one artist's marketing money: planned (Budgets),
          // settled and committed (Campaigns), and the ad pool assigned out.
          tabbed: true,
          key: 'artist-spend',
          label: 'Artist Spend',
          icon: Megaphone,
          children: [
            { path: '/artist-budgets',   label: 'Budgets',      icon: Scale, synonyms: 'artist budget sheet spend variance committed campaign planned marketing spend sheet import xlsx' },
            { path: '/artist-campaigns', label: 'Campaigns',    icon: Megaphone, synonyms: 'marketing campaign promo spend per song' },
            { path: '/bk/advertising',   label: 'Allocate Ads', icon: Target, synonyms: 'advertising facebook meta ads allocate attribute ad spend pool campaign' },
          ],
        },
        { path: '/financials', label: 'Financials',        icon: BarChart2, hidden: true, synonyms: 'balance sheet cash month invoice basis' },
        { path: '/budget',     label: 'Recording Budgets', icon: FileText, hidden: true, synonyms: 'recording budget studio producer template' },
        { path: '/salary',     label: 'Salary',            icon: Wallet, hidden: true, synonyms: 'payroll compensation wages salary' },
      ]
    },
    {
      // One row. Settings is on the BASE_WHITELIST (My Nav + Theme for
      // everyone); every other tab is gated by its own route guard or by the
      // adminOnly flag, which Layout and TabbedShell both honour.
      //
      // John, 2026-09-18: "remove bulk upload, reupload, quickbooks, legal, and
      // mastersheet. they're not needed." Then: "remove the code." So the
      // pages, their routes and their server handlers are gone, not hidden.
      label: 'Admin',
      items: [
        {
          tabbed: true,
          key: 'settings',
          label: 'Settings',
          icon: Settings,
          children: [
            { path: '/settings',            label: 'Settings',     icon: Settings, synonyms: 'preferences theme my nav permissions' },
            { path: '/team',                label: 'Members',      icon: UserCheck, synonyms: 'staff people users team' },
            { path: '/activity',            label: 'Activity',     icon: ScrollText, adminOnly: true, synonyms: 'audit log history who changed' },
            { path: '/admin',               label: 'Admin docs',   icon: ShieldCheck, adminOnly: true, synonyms: 'documentation admin runbook' },
            { path: '/admin/vendor-lab',    label: 'Sandbox',      icon: Send, adminOnly: true, external: true, synonyms: 'vendor form sandbox lab test preview' },
            { path: '/analytics',           label: 'Analytics',    icon: BarChart2, adminOnly: true, hidden: true, synonyms: 'usage pageviews logins' },
          ],
        },
      ]
    },
  ]

export const NAV_PAGES = NAV_GROUPS.flatMap((g) => {
  const group = g.label || 'General'
  // `synonyms` rides along for the ⌘K palette, which matches label + path +
  // synonyms. Dropping it here would make every page findable only by the exact
  // word already printed in the sidebar — which is no help to the person who
  // does not know what the sidebar calls it.
  const row = (i) => ({ path: i.path, label: i.label, group, synonyms: i.synonyms || '', hidden: !!i.hidden })
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
