// Does every tour step's anchor exist on the REAL page with an EMPTY label?
// Renders each tour's page component against anchors-api-stub.js and queries
// each step's selector list. jsdom has no layout, so this is existence, not
// visibility — the bug it catches is an anchor that only renders with data.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ThemeProvider } from '../src/context/ThemeContext'
import { ToastProvider } from '../src/context/ToastContext'
import { BoomRepsProvider } from '../src/context/BoomRepsContext'
import { TOURS } from '../src/tours'
import Dashboard from '../src/pages/Dashboard'
import MyWork from '../src/pages/MyWork'
import Artists from '../src/pages/Artists'
import ArtistProfile from '../src/pages/ArtistProfile'
import Releases from '../src/pages/Releases/index'
import DealPipeline from '../src/pages/DealPipeline'
import Contracts from '../src/pages/Contracts'
import BkApprovals from '../src/pages/BkApprovals'
import BkPayments from '../src/pages/BkPayments'
import Calendar from '../src/pages/Calendar'
import Brand from '../src/pages/Brand'
import Team from '../src/pages/Team'
import Settings from '../src/pages/Settings'
import Messages from '../src/pages/Messages'
import Duplicates from '../src/pages/Duplicates'
import Catalog from '../src/pages/Catalog'
import PendingContracts from '../src/pages/PendingContracts'
import Renewals from '../src/pages/Renewals'
import CreateContract from '../src/pages/CreateContract'
import CreateNDA from '../src/pages/CreateNDA'
import CreateLabelWaiver from '../src/pages/CreateLabelWaiver'
import ArtistClearance from '../src/pages/ArtistClearance'
import CreateInvoice from '../src/pages/CreateInvoice'
import Reports from '../src/pages/Reports'
import AdminDocs from '../src/pages/AdminDocs'
import BkLedger from '../src/pages/BkLedger'
import BkCreators from '../src/pages/BkCreators'
import BkAddInvoice from '../src/pages/BkAddInvoice'
import BkBankMatching from '../src/pages/BkBankMatching'
import BkStatements from '../src/pages/BkStatements'
import BkRules from '../src/pages/BkRules'
import BkVendorsUnified from '../src/pages/BkVendorsUnified'
import Bk1099 from '../src/pages/Bk1099'
import BkAddReimbursement from '../src/pages/BkAddReimbursement'
import BkInvoices from '../src/pages/BkInvoices'
import BkBulkDeals from '../src/pages/BkBulkDeals'
import LedgerMatching from '../src/pages/LedgerMatching'
import Recoupments from '../src/pages/Recoupments'
import RecoupmentsPlanning from '../src/pages/RecoupmentsPlanning'
import RecoupmentsAudit from '../src/pages/RecoupmentsAudit'
import ArtistBudgets from '../src/pages/ArtistBudgets'
import ArtistCampaigns from '../src/pages/ArtistCampaigns'
import AdAllocation from '../src/pages/AdAllocation'
import Financials from '../src/pages/Financials'
import Budget from '../src/pages/Budget'
import Salary from '../src/pages/Salary'
import Analytics from '../src/pages/Analytics'
import ActivityHistory from '../src/pages/ActivityHistory'
import SettingsShell from '../src/components/SettingsShell'

const PAGES = {
  '/': Dashboard, '/my-work': MyWork, '/artists': Artists, '/releases': Releases, '/deals': DealPipeline, '/contracts': Contracts,
  '/bk/approvals': BkApprovals, '/bk/payments': BkPayments, '/calendar': Calendar, '/brand': Brand, '/team': Team, '/settings': Settings,
  '/messages': Messages, '/flags': Duplicates, '/catalog': Catalog, '/pending-contracts': PendingContracts, '/renewals': Renewals, '/contracts/create': CreateContract,
  '/create-nda': CreateNDA, '/create-label-waiver': CreateLabelWaiver, '/create-artist-clearance': ArtistClearance, '/create-invoice': CreateInvoice, '/reports': Reports, '/admin': AdminDocs,
  '/bk/ledger': BkLedger, '/bk/creators': BkCreators, '/bk/add': BkAddInvoice, '/bk/bank-matching': BkBankMatching, '/bk/bank-ledger': () => <BkLedger bank />, '/bk/statements': BkStatements, '/bk/rules': BkRules,
  '/bk/vendors': BkVendorsUnified, '/bk/1099': Bk1099, '/bk/reimburse': BkAddReimbursement, '/bk/invoices': BkInvoices, '/bk/bulk-deals': BkBulkDeals, '/bk/ledger-matching': LedgerMatching,
  '/recoupments': Recoupments, '/recoupments/planning': RecoupmentsPlanning, '/recoupments/audit': RecoupmentsAudit, '/artist-budgets': ArtistBudgets, '/artist-campaigns': ArtistCampaigns, '/bk/advertising': AdAllocation,
  '/financials': Financials, '/budget': Budget, '/salary': Salary, '/analytics': Analytics, '/activity': ActivityHistory,
}
// Anchors that a SHELL renders around the page (BankShell's scope band, the
// family tab strip): not on the page component, so not testable here.
const SHELL_ANCHORS = ['bank-scope', 'family-tabs']
// Layout-owned anchors are not on a page component; tour-dom covers them.
const LAYOUT_ANCHORS = ['sidebar', 'search', 'help', 'notifications', 'walkthrough', 'sidebar-settings', 'bank-scope', 'family-tabs']
const errors = []
window.addEventListener('error', (e) => errors.push('window.error: ' + e.message))
const origErr = console.error
console.error = (...a) => { const m = a.map(String).join(' '); if (!/Future Flag|act\(|not wrapped/.test(m)) errors.push('console.error: ' + m.slice(0, 200)) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const say = (...a) => console.log(...a)
const assert = (label, cond) => say(`  ${label} -> ${!!cond}`)
class Catch extends React.Component { constructor(p) { super(p); this.state = { err: null } } static getDerivedStateFromError(e) { return { err: e } } render() { return this.state.err ? <p data-render-error>{String(this.state.err.message || this.state.err)}</p> : this.props.children } }

async function main() {
  const tours = TOURS.filter((t) => t.id !== 'welcome')
  for (const t of tours) {
    const path = t.match ? '/artists/1' : t.path
    const Page = PAGES[t.path]
    if (!Page) { say(`  ${t.id}: no page component mapped for ${t.path} -> false`); continue }
    const host = document.createElement('div'); document.body.appendChild(host)
    const before = errors.length
    const root = createRoot(host)
    root.render(<Catch><ThemeProvider><ToastProvider><BoomRepsProvider><MemoryRouter initialEntries={[path]}><Routes>
      <Route path="/artists/:id" element={<ArtistProfile />} />
      {/* Layout wraps the Settings family in SettingsShell (the rail the settings tour points at) */}
      <Route path="*" element={t.path === '/settings' ? <SettingsShell><Page /></SettingsShell> : <Page />} />
    </Routes></MemoryRouter></BoomRepsProvider></ToastProvider></ThemeProvider></Catch>)
    // let loading states settle
    for (let i = 0; i < 25; i += 1) { await sleep(120); if (!/Loading|Fetching/.test(host.textContent || '') && i > 4) break }
    await sleep(200)
    const renderErr = host.querySelector('[data-render-error]')?.textContent
    assert(`${t.id}: ${path} renders with an empty label`, !renderErr && errors.length === before)
    if (renderErr) say(`    render error: ${renderErr}`)
    for (const e of errors.slice(before)) say(`    ${e}`)
    for (const st of t.steps) {
      if (st.target === null) continue
      const sels = String(st.target).split(',').map((x) => x.trim())
      const layoutOnly = sels.every((sel) => LAYOUT_ANCHORS.some((a) => sel.includes(`"${a}"`)))
      if (layoutOnly) continue
      const testable = sels.filter((sel) => !LAYOUT_ANCHORS.some((a) => sel.includes(`"${a}"`)))
      const found = testable.find((sel) => { try { return !!host.querySelector(sel) } catch { return false } })
      assert(`${t.id} › “${st.title}”: an anchor exists on the empty page (${found || testable.join(' | ')})`, !!found)
    }
    root.unmount(); host.remove()
  }
  say('DONE'); globalThis.__DONE__ = true
}
main()
