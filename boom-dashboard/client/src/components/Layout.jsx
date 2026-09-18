import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { Outlet, Link, useLocation, Navigate } from 'react-router-dom'
import { NAV_GROUPS, tabFamilyFor } from '../navConfig'
import { useSocket } from '../context/SocketContext'
import {
  LogOut,
  MessageSquarePlus,
  Keyboard,
  X,
  ChevronDown,
  ChevronRight,
  Link2,
  Check,
  Loader,
  CheckCircle2,
  Eye,
  LogIn,
  Settings,
  Upload,
  BookOpen,
  Building2,
  Menu,
  Copy,
  Send,
  Moon,
  Sun,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useTheme } from '../context/ThemeContext'
import GlobalSearch from './GlobalSearch'
import EmailPreviewModal from './EmailPreviewModal'
import KeyboardShortcutsHelp from './KeyboardShortcutsHelp'
import BottomNav from './BottomNav'
import FAB from './FAB'
import NotificationBell from './NotificationBell'
import api from '../api'

const PAGE_LABELS = {
  '/':                   'Home',
  '/my-work':            'My Work',
  '/messages':           'Messages',
  '/artists':            'Artist Roster',
  '/deals':              'Deals',
  '/pending-contracts':  'Pending Contracts',
  '/releases':           'Releases',
  '/catalog':            'Catalog',
  '/flags':              'Flags',
  '/duplicates':         'Flags', // legacy path — redirects to /flags
  '/contracts':          'Contracts',
  '/renewals':           'Renewals',
  '/financials':         'Financials',
  '/reports':            'Reports',
  '/budget':             'Recording Budgets',
  '/team':               'Members',
  '/activity':           'Activity History',
  '/analytics':          'Analytics',
  '/admin':              'Admin Docs',
  '/contracts/create':   'Create Contract',
  '/create-nda':         'Create NDA',
  '/create-label-waiver': 'Create Label Waiver',
  '/create-artist-clearance': 'Create Artist Clearance',
  '/bk/ledger':          'Ledger',
  // The four bank paths all title 'Bank' — they are one page with a tab
  // bar, and the bar says which tab. Every KEY has to stay: resolveBasePath
  // below uses PAGE_LABELS as the "is this a known page" test for the
  // permission gate, so deleting one sends it walking up the path and can
  // bounce a legitimate user to Dashboard.
  '/bk/bank-ledger':     'Bank',
  '/bk/add':             'Add Invoice',
  '/salary':             'Salary',
  '/recoupments':        'Recoupments',
  '/recoupments/planning': 'Recoupment Planning',
  '/bk/1099': '1099 Filing',
  '/recoupments/audit': 'Recoupment Audit',
  '/artist-budgets':     'Artist Budgets',
  '/admin/vendor-lab':  'Vendor Form (sandbox)',
  '/artist-campaigns':   'Artist Campaigns',
  '/bk/advertising':     'Allocate Advertising',
  '/bk/reimburse':       'Add Reimbursement',
  '/bk/approvals':       'Approvals',
  '/bk/vendors':         'Vendors',
  '/bk/creators':        'Creator Payments',
  '/bk/bank-vendors':    'Bank Vendors',
  '/bk/vendor-flags':    'Vendor Flags',
  '/bk/payments':        'Payments',
  '/bk/invoices':        'Invoices',
  '/create-invoice':     'Create Invoice',
  '/calendar':           'Calendar',
  '/bk/bulk-deals':      'Bulk Deals',
  '/bk/ledger-matching': 'Bookkeeper Reconcile',
  '/bk/statements':      'Bank',
  '/bk/bank-matching':   'Bank',
  '/bk/rules':           'Bank',
}

const REQUEST_TYPES = [
  { value: 'workflow',       label: 'Workflow Request',      desc: 'Process or workflow improvements' },
  { value: 'formatting',     label: 'Formatting Feedback',   desc: 'Layout, design, or display issues' },
  { value: 'recommendation', label: 'Feature Recommendation',desc: 'Suggest something new' },
  { value: 'issue',          label: 'Bug / Issue Report',    desc: 'Something not working correctly' },
]

function RequestModal({ onClose, currentPage, user }) {
  const [type, setType] = useState('recommendation')
  const [title, setTitle] = useState('')
  const [details, setDetails] = useState('')
  const [saving, setSaving] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState(null)
  const [pendingEmail, setPendingEmail] = useState(null)

  const submit = async () => {
    if (!title.trim() || !details.trim()) return
    setSaving(true)
    setError(null)
    try {
      const r = await api.post('/requests', {
        type,
        title: title.trim(),
        details: details.trim(),
        page: currentPage,
      })
      if (r.data?.pending_email) {
        setPendingEmail(r.data.pending_email)
      } else {
        setSent(true)
      }
    } catch (err) {
      setError('Failed to send — please try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-end p-6 pointer-events-none">
      <div className="pointer-events-auto w-[400px] bg-white rounded-2xl shadow-2xl border border-gray-100 overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div>
            <h3 className="text-sm font-bold text-gray-900">Send a Request</h3>
            <p className="text-xs text-gray-400 mt-0.5">
              {currentPage ? currentPage : 'Market Street Dashboard'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors p-1 rounded-lg hover:bg-gray-100"
          >
            <X size={16} />
          </button>
        </div>

        {/* Submitting as */}
        {user && (
          <div className="flex items-center gap-2.5 px-5 py-3 bg-gray-50 border-b border-gray-100">
            <div className="w-6 h-6 rounded-full bg-boom-100 flex items-center justify-center flex-shrink-0">
              <span className="text-[10px] font-bold text-boom-700">{user.name?.charAt(0)?.toUpperCase()}</span>
            </div>
            <div className="min-w-0">
              <p className="text-xs text-gray-500">Submitting as <span className="font-semibold text-gray-800">{user.name}</span></p>
              <p className="text-[10px] text-gray-400 truncate">{user.email}</p>
            </div>
          </div>
        )}

        {sent ? (
          <div className="flex flex-col items-center justify-center py-12 px-5 gap-3 text-center">
            <CheckCircle2 size={36} className="text-emerald-500" />
            <p className="text-sm font-semibold text-gray-900">Request sent</p>
            <p className="text-xs text-gray-400">Your request has been sent.</p>
            <button
              onClick={onClose}
              className="mt-2 text-xs font-semibold text-boom-600 hover:text-boom-700 px-4 py-2 rounded-lg border border-boom-200 hover:bg-boom-50 transition-colors"
            >
              Done
            </button>
          </div>
        ) : (
          <div className="p-5 space-y-4">
            {/* Type selector */}
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                Request Type
              </label>
              <div className="grid grid-cols-2 gap-2">
                {REQUEST_TYPES.map(rt => (
                  <button
                    key={rt.value}
                    onClick={() => setType(rt.value)}
                    className={`text-left px-3 py-2.5 rounded-xl border transition-all ${
                      type === rt.value
                        ? 'border-boom-400 bg-boom-50 text-boom-800'
                        : 'border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    <p className={`text-xs font-semibold ${type === rt.value ? 'text-boom-700' : 'text-gray-700'}`}>
                      {rt.label}
                    </p>
                    <p className="text-[10px] text-gray-400 mt-0.5 leading-tight">{rt.desc}</p>
                  </button>
                ))}
              </div>
            </div>

            {/* Title */}
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
                Subject
              </label>
              <input
                autoFocus
                type="text"
                placeholder="Short summary of your request…"
                value={title}
                onChange={e => setTitle(e.target.value)}
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-boom-400 placeholder:text-gray-300"
              />
            </div>

            {/* Details */}
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
                Details
              </label>
              <textarea
                placeholder="Describe what you'd like changed, added, or flagged…"
                value={details}
                onChange={e => setDetails(e.target.value)}
                rows={4}
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-boom-400 placeholder:text-gray-300 resize-none"
              />
            </div>

            {error && (
              <p className="text-xs text-red-500">{error}</p>
            )}

            <button
              onClick={submit}
              disabled={saving || !title.trim() || !details.trim()}
              className="w-full text-sm font-semibold bg-gray-900 text-white py-2.5 rounded-xl hover:bg-gray-800 transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
            >
              {saving ? <><Loader size={14} className="animate-spin" /> Sending…</> : 'Send Request'}
            </button>
          </div>
        )}
      </div>
      {pendingEmail && (
        <EmailPreviewModal
          open
          title="Send request"
          subtitle="Email going to john@deanst.co"
          previewKind={pendingEmail.kind}
          previewContext={pendingEmail.context}
          initialTo={pendingEmail.to}
          initialCc={pendingEmail.cc}
          initialSubject={pendingEmail.subject}
          initialHtml={pendingEmail.html}
          onClose={() => setPendingEmail(null)}
          onSent={() => { setPendingEmail(null); setSent(true) }}
          sendLabel="Send request"
        />
      )}
    </div>
  )
}

// View As dropdown — only rendered for Admins
function ViewAsDropdown() {
  const { user, impersonate, impersonating, exitImpersonation, adminUser } = useAuth()
  const [open, setOpen]   = useState(false)
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(false)
  const ref = useRef(null)

  // Close on outside click
  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleOpen = async () => {
    if (!open && users.length === 0) {
      setLoading(true)
      try {
        const res = await api.get('/auth/users')
        setUsers(res.data.data || [])
      } catch {}
      setLoading(false)
    }
    setOpen(v => !v)
  }

  if (impersonating) {
    return (
      <button
        onClick={exitImpersonation}
        className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100 transition-all"
      >
        <LogIn size={13} />
        Exit — back to {adminUser?.name || 'Admin'}
      </button>
    )
  }

  // Only show for Superadmin (not when impersonating)
  if (user?.role !== 'Superadmin') return null

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={handleOpen}
        className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border transition-all ${
          open
            ? 'bg-gray-900 text-white border-gray-900'
            : 'text-gray-500 border-gray-200 hover:border-gray-300 hover:text-gray-700 hover:bg-gray-50'
        }`}
      >
        <Eye size={13} />
        View as
        <ChevronDown size={11} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-56 bg-white rounded-xl border border-gray-200 shadow-lg z-50 overflow-hidden">
          <p className="px-3 py-2 text-[10px] font-semibold text-gray-400 uppercase tracking-widest border-b border-gray-100">
            View dashboard as…
          </p>
          {loading ? (
            <div className="flex items-center justify-center py-6">
              <div className="w-5 h-5 border-2 border-boom-600 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <div className="py-1">
              {users.filter(u => u.id !== user?.id).map(u => (
                <button
                  key={u.id}
                  onClick={async () => { setOpen(false); await impersonate(u.id) }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-gray-50 transition-colors text-left"
                >
                  <div className="w-6 h-6 rounded-full bg-boom-100 flex items-center justify-center flex-shrink-0">
                    <span className="text-[10px] font-bold text-boom-700">{u.name?.charAt(0)?.toUpperCase()}</span>
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{u.name}</p>
                    <p className="text-[10px] text-gray-400 truncate">{u.role} · {u.department}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function Layout() {
  const { user, logout, impersonating, exitImpersonation, canView } = useAuth()
  const { on } = useSocket()
  const { theme, setTheme } = useTheme()
  const location = useLocation()
  const [showRequest, setShowRequest] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [copiedLink, setCopiedLink] = useState(false)
  const [copiedBilling, setCopiedBilling] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [isMobile, setIsMobile] = useState(false)

  // Responsive sidebar: detect screen size
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1023px)')
    const handler = (e) => {
      setIsMobile(e.matches)
      if (!e.matches) setSidebarOpen(false)
    }
    handler(mq)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // Close sidebar on route change (mobile)
  useEffect(() => {
    if (isMobile) setSidebarOpen(false)
  }, [location.pathname, isMobile])

  // Page-view ping for the admin Analytics page. Fire-and-forget — a
  // failed ping must never affect navigation. Consecutive duplicates
  // skipped; test users are intercepted by the mock adapter anyway.
  const lastViewedPathRef = useRef(null)
  useEffect(() => {
    const path = location.pathname
    if (!user || lastViewedPathRef.current === path) return
    lastViewedPathRef.current = path
    api.post('/analytics/pageview', { path }).catch(() => {})
  }, [location.pathname, user])

  // Swipe right to open sidebar (mobile)
  const touchStartX = useRef(0)
  useEffect(() => {
    if (!isMobile) return
    const handleStart = (e) => { touchStartX.current = e.touches[0].clientX }
    const handleEnd = (e) => {
      const diff = e.changedTouches[0].clientX - touchStartX.current
      if (touchStartX.current < 30 && diff > 60) setSidebarOpen(true)
      if (sidebarOpen && diff < -60) setSidebarOpen(false)
    }
    document.addEventListener('touchstart', handleStart, { passive: true })
    document.addEventListener('touchend', handleEnd, { passive: true })
    return () => {
      document.removeEventListener('touchstart', handleStart)
      document.removeEventListener('touchend', handleEnd)
    }
  }, [isMobile, sidebarOpen])
  // User's personal nav preferences — hide pages they don't want to see
  const [hiddenNavPages, setHiddenNavPages] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('nav_hidden_pages') || '[]')
    } catch { return [] }
  })

  // Re-read when navigating (Settings page writes to localStorage)
  useEffect(() => {
    const refresh = () => {
      try { setHiddenNavPages(JSON.parse(localStorage.getItem('nav_hidden_pages') || '[]')) } catch {}
    }
    window.addEventListener('storage', refresh)
    // Also refresh on route change (same-tab updates)
    refresh()
    return () => window.removeEventListener('storage', refresh)
  }, [location.pathname])
  // Global keyboard shortcut: ? to toggle shortcuts
  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return
      if (e.key === '?') { e.preventDefault(); setShowShortcuts(v => !v) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const [pendingApprovals, setPendingApprovals] = useState(0)
  const [chatUnread, setChatUnread] = useState(0)

  // Collapsible nav sub-groups — persist in localStorage
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('nav_collapsed') || '{}')
    } catch { return {} }
  })
  const toggleCollapsed = (key) => {
    setCollapsed(prev => {
      const next = { ...prev, [key]: !prev[key] }
      localStorage.setItem('nav_collapsed', JSON.stringify(next))
      return next
    })
  }


  // Fetch pending approvals count from the internal bookkeeping API
  useEffect(() => {
    import('../api').then(({ default: api }) => {
      api.get('/bk/pending-count')
        .then(r => setPendingApprovals(r.data?.count || 0))
        .catch(() => {})
    })
  }, [location.pathname])

  // Unread messages badge on /messages.
  //
  // Refetched on navigation like the Approvals count above, but that alone
  // would be a badge that only moves when you click something — so it also
  // refetches on the socket's `message:new`, and on a `chat:read` window event
  // the Messages page fires after it marks a channel read or toggles mute.
  // Without that last one the badge would keep counting a channel you are
  // currently reading until you navigated somewhere else.
  //
  // GET /api/chat/unread already excludes muted channels, so #activity (phase 4)
  // can be loud without owning this number.
  const refreshChatUnread = useCallback(() => {
    // A demo account 403s on every /api/chat call by design, and the client's
    // mock adapter would answer it with an empty array anyway — either way the
    // badge is always zero, so don't ask.
    if (user?.is_test) { setChatUnread(0); return }
    import('../api').then(({ default: api }) => {
      api.get('/chat/unread')
        .then(r => setChatUnread(r.data?.data?.total || 0))
        .catch(() => {})
    })
  }, [user?.is_test])

  useEffect(() => { refreshChatUnread() }, [location.pathname, refreshChatUnread])

  useEffect(() => {
    const offNew = on('message:new', refreshChatUnread)
    const offRead = () => window.removeEventListener('chat:read', refreshChatUnread)
    window.addEventListener('chat:read', refreshChatUnread)
    return () => { offNew(); offRead() }
  }, [on, refreshChatUnread])

  const isSysAdmin = user?.role === 'Admin' || user?.role === 'Superadmin'
  // Sidebar information architecture — organized as the team mentally works:
  //
  //   Home          — what every user opens to start the day
  //   Artists       — A&R surface (roster, pipeline)
  //   Releases      — release ops (pipeline, catalog, marketing, dedup)
  //   Contracts     — admin-only contract lifecycle
  //   Bookkeeping   — day-to-day data entry, approval, payment, lookup
  //   Reports       — read/analyze financial surfaces (P&L, budgets,
  //                   recoupments, salary, bulk deals). Split from
  //                   Bookkeeping so the daily-ops list stays scannable.
  //   Team          — people + personal settings
  //   System        — admin-only audit + legal
  //
  // Within each section, items are ordered by frequency-of-use
  // (descending). Rare or one-off tools live inside a collapsed "More"
  // child rather than at the top level.
  // The nav definition lives in src/navConfig.jsx so Settings' My Nav and
  // Permissions editors read the SAME list instead of a hand-kept copy. Two
  // copies had already drifted: a page missing from Settings entirely, the
  // Bookkeeping group in a different order, and three mismatched labels.
  //
  // Only the dynamic parts are applied here — the sys-admin gate and the
  // Approvals badge, which is per-request state and has no business in a
  // static config.
  const allNavGroups = useMemo(() => NAV_GROUPS
    .filter(g => !g.sysAdminOnly || isSysAdmin)
    .map(g => ({
      ...g,
      // `adminOnly` was declared on Master Sheet Import and read by nothing —
      // the filter above only ever tested `sysAdminOnly`, so the flag was
      // decorative. Honour it rather than delete it: a per-ITEM admin gate is a
      // real thing to want, and a config key that silently does nothing is worse
      // than either having it or not.
      items: g.items
        // `hidden` rows stay in NAV_PAGES (grantable, searchable, known to the
        // permission walk) and are simply not drawn. Children can be hidden
        // too — Analytics inside the Settings family.
        .filter(item => !item.hidden)
        .filter(item => !item.adminOnly || isSysAdmin)
        // A container's CHILDREN carry the flags too — Master Sheet Import is
        // adminOnly and lives inside the Settings family, so filtering only at
        // the top level would leak it into a non-admin's tab bar.
        .map(item => ((item.collapsible || item.tabbed)
          ? { ...item, children: item.children.filter(c => !c.hidden).filter(c => !c.adminOnly || isSysAdmin) }
          : item))
        .map(item => {
          // Badges attach to the PAGE wherever it sits. Approvals is a tab of
          // the Invoices family now, and the family row sums its children's
          // badges, so the count follows the page into its new row.
          const badgeFor = (path) => path === '/bk/approvals' ? pendingApprovals
                                   : path === '/messages' ? chatUnread : undefined
          if (item.collapsible || item.tabbed) {
            return { ...item, children: item.children.map(c => badgeFor(c.path) != null ? { ...c, badge: badgeFor(c.path) } : c) }
          }
          return badgeFor(item.path) != null ? { ...item, badge: badgeFor(item.path) } : item
        }),
    })), [isSysAdmin, pendingApprovals, chatUnread])

  // Filter nav items by page permissions (admins always see everything)
  // All pages the user is allowed to see (for the customize panel)
  const allowedNavGroups = allNavGroups
    .map(group => ({
      ...group,
      items: group.items.filter(item => {
        // A family row survives if ANY of its tabs is viewable — the row is a
        // way in, not a page, so losing one tab must not remove the entrance.
        if (item.collapsible || item.tabbed) return item.children.some(c => canView(c.path))
        return canView(item.path)
      }),
    }))
    .filter(group => group.items.length > 0)

  // Filtered by user's personal visibility preferences
  const navGroups = allowedNavGroups
    .map(group => ({
      ...group,
      items: group.items.filter(item => {
        if (item.collapsible || item.tabbed) {
          // Keep the container if any child is visible
          return item.children.some(c => !hiddenNavPages.includes(c.path))
        }
        return !hiddenNavPages.includes(item.path)
      }).map(item => {
        if (item.collapsible || item.tabbed) {
          return { ...item, children: item.children.filter(c => !hiddenNavPages.includes(c.path)) }
        }
        return item
      }),
    }))
    .filter(group => group.items.length > 0)

  const currentPage = PAGE_LABELS[location.pathname] || null

  // Permission gate. Resolves the current URL to its base path (walking
  // up through :param segments — `/artists/42` → `/artists`) and defers
  // to canView. Admin / Superadmin always pass; Approvers follow their
  // permission rows (bookkeeping fallback when none configured); a User with
  // no explicit grant for the resolved base gets bounced to Dashboard.
  //
  // Runs on every render — cheap since it's a pure lookup — so a User
  // can't stash a URL, sign back in, and land on a page they've since
  // been de-permissioned from.
  const resolveBasePath = (pathname) => {
    if (PAGE_LABELS[pathname]) return pathname
    const parts = pathname.split('/').filter(Boolean)
    while (parts.length > 0) {
      parts.pop()
      const candidate = parts.length ? '/' + parts.join('/') : '/'
      if (PAGE_LABELS[candidate]) return candidate
    }
    return '/'
  }
  const basePath = resolveBasePath(location.pathname)
  if (user && !canView(basePath) && location.pathname !== '/') {
    return <Navigate to="/" replace />
  }

  return (
    <div className="flex h-screen bg-surface-50">
      {/* Mobile backdrop */}
      {isMobile && sidebarOpen && (
        <div
          className="fixed inset-0 bg-overlay z-30 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div className={`
        ${isMobile ? 'fixed inset-y-0 left-0 z-40 transform transition-transform duration-200' : ''}
        ${isMobile && !sidebarOpen ? '-translate-x-full' : 'translate-x-0'}
        w-60 bg-sidebar border-r border-rule flex flex-col flex-shrink-0
      `}>
        {/* Logo */}
        <div className="h-16 flex items-center justify-between px-5 border-b border-divider">
          <span className="text-lg font-bold text-gray-900 tracking-tight">Market Street</span>
          {isMobile && (
            <button onClick={() => setSidebarOpen(false)} className="p-1 text-gray-400 hover:text-gray-600 lg:hidden">
              <X size={18} />
            </button>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-4 overflow-y-auto space-y-4">
          {navGroups.map((group, gi) => (
            <div key={gi}>
              {group.label && (
                <p className="px-3 mb-1 text-[10px] font-semibold text-gray-400 uppercase tracking-widest">
                  {group.label}
                </p>
              )}
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  // ── Tab family: ONE row, the tabs live in the page chrome ──
                  // Links to the first tab the user can actually reach, so a
                  // person granted Planning but not Overview still has a way in
                  // rather than a row that bounces them to the Dashboard.
                  if (item.tabbed) {
                    const first = item.children.find(c => canView(c.path)) || item.children[0]
                    const FamIcon = item.icon
                    const owner = tabFamilyFor(location.pathname)
                    const isActive = owner
                      ? owner.key === item.key
                      : item.children.some(c => location.pathname === c.path || location.pathname.startsWith(c.path + '/'))
                    const famBadge = item.children.reduce((n, c) => n + (c.badge || 0), 0)
                    return (
                      <Link
                        key={item.key}
                        to={first.path}
                        className={`group flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-150 ${
                          isActive ? 'bg-boom-50 text-boom-700' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                        }`}
                      >
                        <FamIcon
                          size={17}
                          strokeWidth={isActive ? 2 : 1.5}
                          className={isActive ? 'text-boom-600' : 'text-gray-400 group-hover:text-gray-600'}
                        />
                        <span>{item.label}</span>
                        {famBadge > 0 && (
                          <span className="ml-auto bg-boom-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none">
                            {famBadge}
                          </span>
                        )}
                      </Link>
                    )
                  }

                  // ── Collapsible sub-group ──
                  if (item.collapsible) {
                    const isOpen = !collapsed[item.key]
                    const SubIcon = item.icon
                    const hasActiveChild = item.children.some(
                      c => location.pathname === c.path || (c.path !== '/' && location.pathname.startsWith(c.path))
                    )
                    return (
                      <div key={item.key}>
                        <button
                          onClick={() => toggleCollapsed(item.key)}
                          className={`w-full group flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-150 ${
                            hasActiveChild && !isOpen
                              ? 'text-boom-700 bg-boom-50/50'
                              : 'text-gray-500 hover:text-gray-900 hover:bg-gray-50'
                          }`}
                        >
                          <SubIcon
                            size={17}
                            strokeWidth={1.5}
                            className={hasActiveChild && !isOpen ? 'text-boom-500' : 'text-gray-400 group-hover:text-gray-600'}
                          />
                          <span className="flex-1 text-left">{item.label}</span>
                          <ChevronRight
                            size={13}
                            className={`text-gray-300 transition-transform duration-150 ${isOpen ? 'rotate-90' : ''}`}
                          />
                        </button>
                        {isOpen && (
                          <div className="ml-5 pl-3 border-l border-gray-100 mt-0.5 space-y-0.5">
                            {item.children.filter(c => canView(c.path)).map(child => {
                              const ChildIcon = child.icon
                              const isActive = location.pathname === child.path || (child.path !== '/' && location.pathname.startsWith(child.path))
                              return (
                                <Link
                                  key={child.path}
                                  to={child.path}
                                  className={`group flex items-center gap-3 px-3 py-1.5 rounded-lg text-[13px] font-medium transition-all duration-150 ${
                                    isActive
                                      ? 'bg-boom-50 text-boom-700'
                                      : 'text-gray-500 hover:text-gray-900 hover:bg-gray-50'
                                  }`}
                                >
                                  <ChildIcon
                                    size={15}
                                    strokeWidth={isActive ? 2 : 1.5}
                                    className={isActive ? 'text-boom-600' : 'text-gray-400 group-hover:text-gray-600'}
                                  />
                                  <span>{child.label}</span>
                                </Link>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  }

                  // ── Regular nav item ──
                  const { path, label, icon: Icon, badge, external } = item
                  const isActive = !external && (location.pathname === path || (path !== '/' && location.pathname.startsWith(path)))
                  // External targets (e.g. the public /submit page) need a
                  // hard navigation in a new tab so the admin's session
                  // stays open and App.jsx's pathname-based early-return
                  // for /submit fires.
                  const linkClasses = `group flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-150 ${
                    isActive
                      ? 'bg-boom-50 text-boom-700'
                      : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                  }`
                  const linkContents = (
                    <>
                      <Icon
                        size={17}
                        strokeWidth={isActive ? 2 : 1.5}
                        className={isActive ? 'text-boom-600' : 'text-gray-400 group-hover:text-gray-600'}
                      />
                      <span>{label}</span>
                      {badge > 0 && (
                        <span className="ml-auto bg-boom-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none">
                          {badge}
                        </span>
                      )}
                    </>
                  )
                  return external ? (
                    <a key={path} href={path} target="_blank" rel="noopener noreferrer" className={linkClasses}>
                      {linkContents}
                    </a>
                  ) : (
                    <Link key={path} to={path} className={linkClasses}>
                      {linkContents}
                    </Link>
                  )
                })}
              </div>
            </div>
          ))}

          {/* Vendor Submit Form link */}
          <div className="mt-2 pt-2 border-t border-divider">
            <button
              onClick={() => {
                const url = `${window.location.origin}/submit`
                navigator.clipboard.writeText(url).then(() => {
                  setCopiedLink(true)
                  setTimeout(() => setCopiedLink(false), 2000)
                })
              }}
              className="group flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-150 text-gray-500 hover:text-gray-900 hover:bg-gray-50 w-full"
            >
              {copiedLink
                ? <Check size={17} strokeWidth={1.5} className="text-emerald-500" />
                : <Link2 size={17} strokeWidth={1.5} className="text-gray-400 group-hover:text-gray-600" />
              }
              <span>{copiedLink ? 'Link copied!' : 'Vendor Form'}</span>
              {!copiedLink && (
                <span className="ml-auto text-[10px] text-gray-300 font-normal">Copy link</span>
              )}
            </button>
            {/* Market Street billing address — one click to paste into a vendor's
                "bill to" field. Mirrors the invoice remittance block
                (CreateInvoice BOOM_INFO). */}
            <button
              onClick={() => {
                // TODO(marketst): real billing address — keep in sync with CreateInvoice BOOM_INFO.
                const address = [
                  'MARKET STREET',
                  'STREET ADDRESS',
                  'CITY STATE ZIP USA',
                ].join('\n')
                navigator.clipboard.writeText(address).then(() => {
                  setCopiedBilling(true)
                  setTimeout(() => setCopiedBilling(false), 2000)
                })
              }}
              className="group flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-150 text-gray-500 hover:text-gray-900 hover:bg-gray-50 w-full"
            >
              {copiedBilling
                ? <Check size={17} strokeWidth={1.5} className="text-emerald-500" />
                : <Building2 size={17} strokeWidth={1.5} className="text-gray-400 group-hover:text-gray-600" />
              }
              <span>{copiedBilling ? 'Address copied!' : 'Market Street Billing'}</span>
              {!copiedBilling && (
                <span className="ml-auto text-[10px] text-gray-300 font-normal">Copy address</span>
              )}
            </button>
          </div>
        </nav>

        {/* User Info & Logout */}
        <div className="p-3 border-t border-divider">
          {user && (
            <div className="flex items-center gap-3 px-3 py-2 mb-2">
              <div className="w-8 h-8 rounded-full bg-boom-100 flex items-center justify-center flex-shrink-0">
                <span className="text-sm font-semibold text-boom-700">
                  {user.name?.charAt(0)?.toUpperCase()}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">{user.name}</p>
                <p className="text-xs text-gray-500 truncate">{user.role}</p>
              </div>
            </div>
          )}
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-50 rounded-lg transition-all duration-150"
          >
            <LogOut size={16} strokeWidth={1.5} />
            <span>Sign out</span>
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Impersonation banner */}
        {impersonating && (
          <div className="flex items-center justify-between px-6 py-2 bg-amber-400 text-amber-900 text-xs font-semibold flex-shrink-0">
            <div className="flex items-center gap-2">
              <Eye size={13} />
              <span>Viewing as <span className="font-bold">{user?.name}</span> ({user?.role} · {user?.department}) — this is their exact view</span>
            </div>
            <button
              onClick={exitImpersonation}
              className="flex items-center gap-1 font-bold hover:underline"
            >
              <X size={12} /> Exit
            </button>
          </div>
        )}
        {/* Demo-mode banner — test account, all data is mocked */}
        {user?.is_test && (
          <div className="flex items-center gap-2 px-6 py-2 bg-violet-600 text-white text-xs font-semibold flex-shrink-0">
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-white/20 text-[10px] uppercase tracking-wider">Demo Mode</span>
            <span>You're signed in to a test account. Every screen shows sample data — no real Market Street information is visible.</span>
          </div>
        )}
        {/* Top header */}
        <div className="h-14 flex items-center gap-3 px-4 lg:px-6 border-b border-divider bg-header flex-shrink-0">
          {/* Hamburger menu — mobile only */}
          {isMobile && (
            <button
              onClick={() => setSidebarOpen(true)}
              className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors lg:hidden"
            >
              <Menu size={20} />
            </button>
          )}
          <GlobalSearch />
          <NotificationBell />
          <span className="hidden sm:block"><ViewAsDropdown /></span>
          {/* Shortcuts button */}
          <button
            onClick={() => setShowShortcuts(v => !v)}
            className={`hidden sm:inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border transition-all ${
              showShortcuts
                ? 'bg-gray-900 text-white border-gray-900'
                : 'text-gray-500 border-gray-200 hover:border-gray-300 hover:text-gray-700 hover:bg-gray-50'
            }`}
          >
            <Keyboard size={13} />
          </button>
          {/* User manual button */}
          <button
            onClick={() => window.open('/manual', '_blank', 'noopener')}
            title="Open your user manual"
            className="hidden sm:inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border transition-all text-gray-500 border-gray-200 hover:border-gray-300 hover:text-gray-700 hover:bg-gray-50"
          >
            <BookOpen size={13} />
          </button>
          {/* Theme toggle — flips between light + dark. ThemeContext
              persists to localStorage and adds/removes the `dark` class
              on <html> so the early init script in main.jsx can apply it
              before React mounts on the next load (no flash). */}
          <button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border transition-all text-gray-500 border-gray-200 hover:border-gray-300 hover:text-gray-700 hover:bg-gray-50"
          >
            {theme === 'dark' ? <Sun size={13} /> : <Moon size={13} />}
          </button>
          {/* Request button */}
          {!impersonating && (
            <button
              onClick={() => setShowRequest(v => !v)}
              className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border transition-all ${
                showRequest
                  ? 'bg-gray-900 text-white border-gray-900'
                  : 'text-gray-500 border-gray-200 hover:border-gray-300 hover:text-gray-700 hover:bg-gray-50'
              }`}
            >
              <MessageSquarePlus size={13} />
              Request
            </button>
          )}
        </div>
        <main className="flex-1 overflow-auto">
          <div className="max-w-7xl mx-auto px-4 py-6 pb-20 sm:px-6 sm:py-8 sm:pb-8">
            <Outlet />
          </div>
        </main>
      </div>

      {/* Shortcuts modal */}
      <KeyboardShortcutsHelp open={showShortcuts} onClose={() => setShowShortcuts(false)} />

      {/* Mobile bottom nav + FAB */}
      <BottomNav onOpenSidebar={() => setSidebarOpen(true)} />
      <FAB />

      {/* Request modal */}
      {showRequest && (
        <RequestModal
          onClose={() => setShowRequest(false)}
          currentPage={currentPage}
          user={user}
        />
      )}
    </div>
  )

  function handleLogout() {
    logout()
  }
}
