import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import { FxRatesProvider } from './context/FxRatesContext'
import { BoomRepsProvider } from './context/BoomRepsContext'
import { CategoriesProvider } from './context/CategoriesContext'
import { SocketProvider } from './context/SocketContext'
import Layout from './components/Layout'
import TabbedShell from './components/TabbedShell'
import BankShell from './components/BankShell'
import BkCreators from './pages/BkCreators'
import Bk1099 from './pages/Bk1099'
import Login from './pages/Login'
import SetPassword from './pages/SetPassword'
import Dashboard from './pages/Dashboard'
import Releases from './pages/Releases'
import Artists from './pages/Artists'
import ArtistProfile from './pages/ArtistProfile'
import DealPipeline from './pages/DealPipeline'
import Team from './pages/Team'
import TeamMember from './pages/TeamMember'
import MyWork from './pages/MyWork'
import Contracts from './pages/Contracts'
import CreateContract from './pages/CreateContract'
import Renewals from './pages/Renewals'
import Financials from './pages/Financials'
import Budget from './pages/Budget'
import BudgetDetail from './pages/BudgetDetail'
import PendingContracts from './pages/PendingContracts'
import ReleaseDetail from './pages/ReleaseDetail'
import Catalog from './pages/Catalog'
import Duplicates from './pages/Duplicates'
import ActivityHistory from './pages/ActivityHistory'
import Analytics from './pages/Analytics'
import Settings from './pages/Settings'
import CreateInvoice from './pages/CreateInvoice'
import CreateNDA from './pages/CreateNDA'
import CreateLabelWaiver from './pages/CreateLabelWaiver'
import ArtistClearance from './pages/ArtistClearance'
import Calendar from './pages/Calendar'
// Bookkeeping iframe pages
import BkLedger from './pages/BkLedger'
import BkAddInvoice from './pages/BkAddInvoice'
import BkAddReimbursement from './pages/BkAddReimbursement'
import BkApprovals from './pages/BkApprovals'
import BkArchive from './pages/BkArchive'
import RecoupmentsPlanning from './pages/RecoupmentsPlanning'
import Recoupments2025 from './pages/Recoupments2025'
import RecoupmentsAudit from './pages/RecoupmentsAudit'
import ArtistBudgets from './pages/ArtistBudgets'
import ArtistBudgetSheet from './pages/ArtistBudgetSheet'
import ArtistBudgetSimple from './pages/ArtistBudgetSimple'
import BkVendors from './pages/BkVendors'
import BkVendorsAdded from './pages/BkVendorsAdded'
import BkPayments from './pages/BkPayments'
import Privacy from './pages/Privacy'
import EULA from './pages/EULA'
import Salary from './pages/Salary'
import Recoupments from './pages/Recoupments'
import ArtistCampaigns from './pages/ArtistCampaigns'
import AdAllocation from './pages/AdAllocation'
import BkInvoices from './pages/BkInvoices'
import BkBulkDeals from './pages/BkBulkDeals'
import LedgerMatching from './pages/LedgerMatching'
import BkStatements from './pages/BkStatements'
import BkBankMatching from './pages/BkBankMatching'
import BkRules from './pages/BkRules'
// BkBankVendors deleted — BkVendorsUnified superseded it and /bk/bank-vendors
// has redirected there for some time. BkVendorFlags is still very much alive,
// but it is imported by BkVendorsUnified (its Duplicates tab), not here: this
// file only redirects the old /bk/vendor-flags URL.
import BkVendorsUnified from './pages/BkVendorsUnified'
import Reports from './pages/Reports'
import VendorSubmit from './pages/VendorSubmit'
import VendorSubmitLab from './pages/VendorSubmitLab'
import UserManual from './pages/UserManual'
import AdminDocs from './pages/AdminDocs'
import Messages from './pages/Messages'

function ProtectedRoute({ children }) {
  const { token, user, loading, canView } = useAuth()
  const location = useLocation()

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-surface-50">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-boom-600 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-gray-500">Loading...</p>
        </div>
      </div>
    )
  }

  if (!token) {
    return <Navigate to="/login" />
  }

  // Sidebar hides pages the user can't see; this enforces the same
  // rule when they paste a URL directly. Only guards the current path;
  // when the user is unauthorized, bounce to Dashboard (the base
  // whitelist entry) so they don't loop on a redirect.
  if (user && !canView(location.pathname)) {
    return <Navigate to="/" replace />
  }

  return children
}

// Permission-aware route guard for routes that were historically
// admin-only but can now be unlocked for specific Users via the
// page_permissions matrix. Defers to canView(currentPath), so the
// logic stays in lockstep with the sidebar nav: if a user sees the
// nav link, they can also visit the page. Without this, a User with
// an explicit grant for /contracts would see the nav link but get
// redirected back to "/" when clicking it (the previous role-only
// gate didn't know about the grant).
function AdminRoute({ children }) {
  const { user, loading, canView } = useAuth()
  const location = useLocation()
  if (loading) return null
  if (!user) return <Navigate to="/login" replace />
  if (!canView(location.pathname)) return <Navigate to="/" replace />
  return children
}

// Stricter gate — used for the Admin Docs vault (/admin), which holds
// NDAs / HR docs / etc. that even Approvers shouldn't see. This is the
// one route still gated by raw role rather than page_permissions
// because there's no permissions-matrix entry for /admin and there
// shouldn't be — vault access is reserved.
function StrictAdminRoute({ children }) {
  const { user, loading } = useAuth()
  if (loading) return null
  if (!['Superadmin', 'Admin'].includes(user?.role)) {
    return <Navigate to="/" replace />
  }
  return children
}

function AppContent() {
  const { token } = useAuth()

  // Public routes — accessible without login
  if (window.location.pathname === '/submit') return <VendorSubmit />
  // /admin/vendor-preview was the same form, admin-only, and it still WROTE —
  // a real approval, a real upload, real email. It sat one row above the sandbox
  // in the nav under a near-identical label. Removed 2026-08-27; the path
  // redirects rather than 404s so a bookmark or an old doc link lands on the
  // surface that answers the same question without creating anything.
  if (window.location.pathname === '/admin/vendor-preview') {
    window.location.replace('/admin/vendor-lab')
    return null
  }
  // The sandbox copy — now the only internal way to look at the vendor form.
  // A pathname rather than a query param, because a query param can be stripped
  // and a pathname cannot. Its submissions write nothing: see the ?sandbox=1
  // branch in routes/vendor-submit.js, and scripts/sync-vendor-lab.mjs for how
  // the copy is kept honest.
  if (window.location.pathname === '/admin/vendor-lab') {
    if (!token) return <Login />
    return <VendorSubmitLab />
  }
  // A new teammate's invite link — public, before the login gate.
  if (window.location.pathname.startsWith('/invite/')) return <SetPassword />
  if (window.location.pathname === '/privacy') return <Privacy />
  if (window.location.pathname === '/eula') return <EULA />

  if (!token) {
    return <Login />
  }

  return (
    <Routes>
      <Route path="/submit" element={<VendorSubmit />} />
      <Route path="/privacy" element={<Privacy />} />
      <Route path="/eula" element={<EULA />} />
      <Route path="/manual" element={<UserManual />} />
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/releases" element={<TabbedShell family="releases"><Releases /></TabbedShell>} />
        <Route path="/releases/:id" element={<ReleaseDetail />} />
        <Route path="/artists" element={<Artists />} />
        <Route path="/artists/:id" element={<ArtistProfile />} />
        <Route path="/deals" element={<TabbedShell family="contracts"><DealPipeline /></TabbedShell>} />
        <Route path="/team" element={<TabbedShell family="settings"><Team /></TabbedShell>} />
        <Route path="/team/:id" element={<TeamMember />} />
        <Route path="/my-work" element={<MyWork />} />
        {/* '/messages' is on the BASE_WHITELIST (lib/pageAccess.js + its server
            mirror), so ProtectedRoute lets every role through. Membership in a
            channel is what bounds you, enforced in server/routes/chat.js. */}
        <Route path="/messages" element={<Messages />} />
        <Route path="/messages/:channelId" element={<Messages />} />
        <Route path="/contracts" element={<AdminRoute><TabbedShell family="contracts"><Contracts /></TabbedShell></AdminRoute>} />
        <Route path="/contracts/create" element={<AdminRoute><TabbedShell family="documents"><CreateContract /></TabbedShell></AdminRoute>} />
        <Route path="/renewals" element={<AdminRoute><TabbedShell family="contracts"><Renewals /></TabbedShell></AdminRoute>} />
        <Route path="/financials" element={<Financials />} />
        <Route path="/financials/month/:month" element={<Financials />} />
        <Route path="/budget" element={<Budget />} />
        <Route path="/budget/:id" element={<BudgetDetail />} />
        <Route path="/pending-contracts" element={<AdminRoute><TabbedShell family="contracts"><PendingContracts /></TabbedShell></AdminRoute>} />
        <Route path="/catalog" element={<TabbedShell family="releases"><Catalog /></TabbedShell>} />
        {/* Global flags hub. /duplicates was its old home — kept as a
            redirect so existing links and bookmarks land in the hub. */}
        <Route path="/flags" element={<Duplicates />} />
        <Route path="/duplicates" element={<Navigate to="/flags" replace />} />
        <Route path="/create-invoice" element={<TabbedShell family="documents"><CreateInvoice /></TabbedShell>} />
        <Route path="/create-nda" element={<TabbedShell family="documents"><CreateNDA /></TabbedShell>} />
        <Route path="/create-nda/:template" element={<TabbedShell family="documents"><CreateNDA /></TabbedShell>} />
        <Route path="/create-label-waiver" element={<TabbedShell family="documents"><CreateLabelWaiver /></TabbedShell>} />
        <Route path="/create-artist-clearance" element={<TabbedShell family="documents"><ArtistClearance /></TabbedShell>} />
        <Route path="/calendar" element={<Calendar />} />
        <Route path="/activity" element={<TabbedShell family="settings"><ActivityHistory /></TabbedShell>} />
        <Route path="/analytics" element={<StrictAdminRoute><Analytics /></StrictAdminRoute>} />
        <Route path="/admin" element={<StrictAdminRoute><TabbedShell family="settings"><AdminDocs /></TabbedShell></StrictAdminRoute>} />
        <Route path="/settings" element={<TabbedShell family="settings"><Settings /></TabbedShell>} />
        {/* Bookkeeping routes — iframe-embedded Flask app */}
        <Route path="/bk/ledger"    element={<TabbedShell family="invoices"><BkLedger /></TabbedShell>} />
        {/* The other half of the ledger. Same component: 2,326 of the 3,692
            rows were created by booking a bank debit, and every invoice control
            — approve, mark paid, W9, invoice file — is inert on them. `bank`
            flips the source filter, the column set and the copy; sort, search,
            export and inline edit stay literally the same code, so the two
            halves cannot drift. */}
        <Route path="/bk/bank-ledger" element={<BankShell><BkLedger bank /></BankShell>} />
        <Route path="/bk/add"       element={<TabbedShell family="invoices"><BkAddInvoice /></TabbedShell>} />
        <Route path="/bk/reimburse" element={<BkAddReimbursement />} />
        <Route path="/bk/approvals" element={<TabbedShell family="invoices"><BkApprovals /></TabbedShell>} />
        <Route path="/bk/approvals/archive" element={<BkArchive />} />
        {/* Wrapped, not nested — the tab bar is chrome and neither URL moved.
            /bk/vendors/:vendorName and /bk/vendors/added-expenses stay OUT of
            the family, exactly as /recoupments/:artistName does: a vendor's own
            page is a destination reached from the directory, not a sibling tab
            of it. */}
        <Route path="/bk/vendors"   element={<TabbedShell family="vendors"><BkVendorsUnified /></TabbedShell>} />
        <Route path="/bk/creators"  element={<TabbedShell family="invoices"><BkCreators /></TabbedShell>} />
        <Route path="/bk/vendors/added-expenses" element={<BkVendorsAdded />} />
        <Route path="/bk/vendors/:vendorName" element={<BkVendors />} />
        <Route path="/bk/payments"  element={<TabbedShell family="invoices"><BkPayments /></TabbedShell>} />
        <Route path="/salary"       element={<AdminRoute><Salary /></AdminRoute>} />
        <Route path="/recoupments" element={<TabbedShell family="recoupments"><Recoupments /></TabbedShell>} />
        <Route path="/recoupments/planning" element={<TabbedShell family="recoupments"><RecoupmentsPlanning /></TabbedShell>} />
        <Route path="/recoupments/2025" element={<Recoupments2025 />} />
        <Route path="/recoupments/audit" element={<TabbedShell family="recoupments"><RecoupmentsAudit /></TabbedShell>} />
        <Route path="/artist-budgets" element={<TabbedShell family="artist-spend"><ArtistBudgets /></TabbedShell>} />
        {/* The simple sheet is THE sheet (John, 2026-09-18: "basic and editable
            … total artist budgets (advance, total marketing) and release
            budgets inside that"). The category grid it replaced stays one
            click away at /detail — a descendant path, so a grant on
            /artist-budgets covers it exactly as it covers the sheet. */}
        <Route path="/artist-budgets/:artistKey" element={<ArtistBudgetSimple />} />
        <Route path="/artist-budgets/:artistKey/detail" element={<ArtistBudgetSheet />} />
        <Route path="/recoupments/:artistName" element={<TabbedShell family="recoupments"><Recoupments /></TabbedShell>} />
        <Route path="/bk/advertising" element={<TabbedShell family="artist-spend"><AdAllocation /></TabbedShell>} />
        <Route path="/artist-campaigns" element={<TabbedShell family="artist-spend"><ArtistCampaigns /></TabbedShell>} />
        <Route path="/artist-campaigns/:artistName" element={<TabbedShell family="artist-spend"><ArtistCampaigns /></TabbedShell>} />
        <Route path="/artist-campaigns/:artistName/:songName" element={<TabbedShell family="artist-spend"><ArtistCampaigns /></TabbedShell>} />
        <Route path="/bk/invoices"  element={<BkInvoices />} />
        <Route path="/bk/bulk-deals" element={<BkBulkDeals />} />
        <Route path="/bk/ledger-matching" element={<LedgerMatching />} />
        {/* Wrapped, not nested — the same shape the vendors / import /
            recoupments families use, and for the same reason: the tab bar is
            chrome and no URL moved. BankShell adds the shared account +
            statement + tie-out header ABOVE the bar, so it survives
            TabbedShell's single-visible-tab path, where the bar itself does
            not render at all. /bk/bank-ledger is wrapped up with the ledger it
            shares a component with. */}
        <Route path="/bk/statements" element={<BankShell><BkStatements /></BankShell>} />
        <Route path="/bk/bank-matching" element={<BankShell><BkBankMatching /></BankShell>} />
        <Route path="/bk/rules" element={<BankShell><BkRules /></BankShell>} />
        <Route path="/bk/bank-vendors" element={<Navigate to="/bk/vendors" replace />} />
        <Route path="/bk/1099" element={<TabbedShell family="vendors"><Bk1099 /></TabbedShell>} />
        <Route path="/bk/vendor-flags" element={<Navigate to="/bk/vendors?tab=duplicates" replace />} />
        <Route path="/reports" element={<Reports />} />
      </Route>
    </Routes>
  )
}

export default function App() {
  return (
    <AuthProvider>
      {/* Below AuthProvider on purpose: the socket authenticates with the JWT
          and must not exist before there is one. It connects when a token
          appears and disconnects on logout — see SocketContext. */}
      <SocketProvider>
        <FxRatesProvider>
          <BoomRepsProvider>
            <CategoriesProvider>
              <AppContent />
            </CategoriesProvider>
          </BoomRepsProvider>
        </FxRatesProvider>
      </SocketProvider>
    </AuthProvider>
  )
}
