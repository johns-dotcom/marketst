import { useState, useEffect, Fragment } from 'react'
import { Users, Plus, Trash2, X, Loader, CheckCircle2, Check, SlidersHorizontal, Sun, Moon, Monitor, Archive, Download, FileSpreadsheet, FolderArchive, AlertTriangle, EyeOff, Search, ChevronRight, ChevronDown, UserCircle2, KeyRound, Bell, Building2, Plug, ScrollText, Send, ExternalLink, LogOut } from 'lucide-react'
import api from '../api'
import { NAV_PAGES, NAV_GROUPS } from '../navConfig'
import { Link, useSearchParams } from 'react-router-dom'
import { refreshLabel } from '../hooks/useLabel'
import MailCard, { MyMailbox } from '../components/MailCard'
import QuickBooksCard from '../components/QuickBooksCard'
import DocuSignCard from '../components/DocuSignCard'
import { ROLES, AXES } from '../lib/roles'
import { useAuth } from '../context/AuthContext'
import { useTheme } from '../context/ThemeContext'
import PageHeader from '../components/PageHeader'
import useHotkeys from '../hooks/useHotkeys'
import { NavGrid, DepartmentNavsTab } from '../components/NavEditors'
import PasswordInput from '../components/PasswordInput'

// Groupings mirror the sidebar nav (Layout.jsx) so what an admin sees in
// Permissions / My Nav lines up with the structure they navigate every day.
// When the sidebar adds, renames, or regroups a page, mirror it here too.
// The page list for the My Nav toggles and the Permissions editor is DERIVED
// from the sidebar definition, not maintained alongside it. This used to be a
// hand-kept array and it had drifted from the nav it configures:
// /admin/vendor-preview was missing entirely (the one page you could neither
// grant nor hide), the Bookkeeping group was in a different order, and three
// labels disagreed. Same shape as before — { path, label, group } — so every
// consumer below is unchanged.
const ALL_PAGES = NAV_PAGES

// Approver = semi-admin role — can approve/reject invoices on the Approvals
// page but has no other admin powers (no user management, no deletes, no
// exports). Superadmin-only to grant so the capability stays scoped.
// Departments and role presets live in lib/navPresets.js — one definition,
// read by the user form (default tick from department), the Permissions
// editor (additive apply) and client/scripts/navpresets-fixture.mjs.



// ─── My settings (2026-09-19) ────────────────────────────────────────────────
function ProfileTab({ onSaved }) {
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState('')
  useEffect(() => { api.get('/settings/me').then((r) => setForm({ name: r.data.data.name || '', title: r.data.data.title || '', phone: r.data.data.phone || '', email: r.data.data.email, role: r.data.data.role, department: r.data.data.department })).catch(() => setForm({})) }, [])
  if (!form) return <p className="text-sm text-gray-400">Loading…</p>
  const save = async (e) => {
    e.preventDefault(); setSaving(true); setNote('')
    try { const r = await api.put('/settings/me', { name: form.name, title: form.title, phone: form.phone }); setNote('Saved'); onSaved && onSaved(r.data.data) }
    catch (err) { setNote(err?.response?.data?.error || 'Could not save') }
    finally { setSaving(false); setTimeout(() => setNote(''), 2500) }
  }
  return (
    <form onSubmit={save} className="max-w-lg space-y-4" data-tab-profile>
      <div className="grid sm:grid-cols-2 gap-4">
        <label className="block sm:col-span-2"><span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Name</span>
          <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required className="input-base w-full mt-1" /></label>
        <label className="block"><span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Title</span>
          <input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="e.g. Head of A&R" className="input-base w-full mt-1" /></label>
        <label className="block"><span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Phone</span>
          <input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} placeholder="+1 …" className="input-base w-full mt-1" /></label>
      </div>
      <div className="text-xs text-gray-500 space-y-0.5 border border-rule rounded-lg p-3 bg-gray-50/60">
        <p><span className="font-semibold text-gray-700">{form.email}</span> · {form.role}{form.department ? ` · ${form.department}` : ''}</p>
        <p>Email, role and department are set by an admin under People.</p>
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={saving} className="btn-primary text-sm px-4 py-2">{saving ? 'Saving…' : 'Save profile'}</button>
        {note && <span className="text-xs text-gray-500" data-note>{note}</span>}
      </div>
    </form>
  )
}

function SignInTab() {
  const { logout } = useAuth()
  const [cur, setCur] = useState(''); const [next, setNext] = useState(''); const [again, setAgain] = useState('')
  const [saving, setSaving] = useState(false); const [note, setNote] = useState(''); const [err, setErr] = useState('')
  const [sessions, setSessions] = useState(null)
  // Someone who accepted their invite by signing in with Google has NO password
  // yet: they set their first one here without a "current" one to type.
  const [hasPassword, setHasPassword] = useState(true)
  useEffect(() => { api.get('/settings/me/sessions').then((r) => setSessions(r.data.data || [])).catch(() => setSessions([])) }, [])
  useEffect(() => { api.get('/settings/me').then((r) => { if (r.data?.data?.has_password === false) setHasPassword(false) }).catch(() => {}) }, [])
  const change = async (e) => {
    e.preventDefault(); setErr(''); setNote('')
    if (next.length < 8) return setErr('The new password needs at least 8 characters.')
    if (next !== again) return setErr('The two new passwords do not match.')
    setSaving(true)
    try { const r = await api.post('/auth/change-password', hasPassword ? { current_password: cur, new_password: next } : { new_password: next }); setNote(r.data?.first_password ? 'Password set. You can sign in with it or with Google.' : 'Password changed. Other sessions were signed out.'); setCur(''); setNext(''); setAgain(''); if (!hasPassword) setHasPassword(true) }
    catch (e2) { setErr(e2?.response?.data?.error || 'Could not change the password') }
    finally { setSaving(false) }
  }
  const signOutEverywhere = async () => {
    if (!window.confirm('Sign out of every device, including this one?')) return
    try { await api.post('/auth/logout-all') } catch { /* the token is invalid either way */ }
    logout()
  }
  const agent = (ua) => { const s = String(ua || ''); const b = /Edg\//.test(s) ? 'Edge' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : /Firefox\//.test(s) ? 'Firefox' : 'Browser'; const o = /Mac OS X/.test(s) ? 'Mac' : /Windows/.test(s) ? 'Windows' : /iPhone|iPad/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android' : /Linux/.test(s) ? 'Linux' : ''; return [b, o].filter(Boolean).join(' · ') }
  return (
    <div className="grid lg:grid-cols-2 gap-8" data-tab-signin>
      <form onSubmit={change} className="space-y-3 max-w-md" data-password-form={hasPassword ? 'change' : 'set'}>
        <h3 className="text-sm font-semibold text-gray-900">{hasPassword ? 'Change password' : 'Set a password'}</h3>
        {!hasPassword && <p className="text-xs text-gray-500" data-set-password-why>You signed in with Google, so this account has no password yet. Set one to sign in without Google too — Google keeps working either way.</p>}
        {hasPassword && <PasswordInput value={cur} onChange={(e) => setCur(e.target.value)} placeholder="Current password" autoComplete="current-password" className="input-base w-full" required />}
        <PasswordInput value={next} onChange={(e) => setNext(e.target.value)} placeholder="New password (8+ characters)" autoComplete="new-password" className="input-base w-full" required />
        <PasswordInput value={again} onChange={(e) => setAgain(e.target.value)} placeholder="New password again" autoComplete="new-password" className="input-base w-full" required />
        {err && <p className="text-xs text-rose-600" data-signin-error>{err}</p>}
        {note && <p className="text-xs text-emerald-700" data-signin-note>{note}</p>}
        <button type="submit" disabled={saving} className="btn-primary text-sm px-4 py-2" data-password-submit>{saving ? 'Saving…' : hasPassword ? 'Change password' : 'Set password'}</button>
        <p className="text-[11px] text-gray-400">{hasPassword ? 'Changing it signs out every other session.' : 'Setting it keeps this session signed in.'}</p>
      </form>
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-gray-900">Recent sign-ins</h3>
          <button onClick={signOutEverywhere} className="inline-flex items-center gap-1.5 text-xs font-semibold text-rose-700 border border-rose-200 rounded-lg px-2.5 py-1.5 hover:bg-rose-50" data-signout-all><LogOut size={12} /> Sign out everywhere</button>
        </div>
        {sessions === null ? <p className="text-sm text-gray-400">Loading…</p>
          : sessions.length === 0 ? <p className="text-sm text-gray-400">No sign-ins recorded yet.</p>
          : (
            <ul className="divide-y divide-divider border border-rule rounded-lg">
              {sessions.map((s) => (
                <li key={s.id} className="px-3 py-2 flex items-center justify-between text-xs">
                  <span className="text-gray-700">{agent(s.user_agent)}</span>
                  <span className="text-gray-400 tabular-nums">{new Date(s.logged_in_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}{s.ip_address ? ` · ${s.ip_address}` : ''}</span>
                </li>
              ))}
            </ul>
          )}
      </div>
    </div>
  )
}

const NOTIFY_LABELS = {
  approvals_waiting: ['Invoices waiting for approval', 'A daily note when the Approvals queue is not empty.'],
  payments_due: ['Payments due this week', 'Each Monday, what is due in the next seven days.'],
  tasks_assigned: ['A task is assigned to me', 'The moment somebody assigns one.'],
  renewals_coming: ['Contracts expiring within 90 days', 'Once, when a contract enters the window.'],
  weekly_digest: ['Weekly digest', 'Friday: what moved this week across the loop.'],
}
function NotificationsTab() {
  const [prefs, setPrefs] = useState(null); const [gmail, setGmail] = useState(false); const [note, setNote] = useState('')
  useEffect(() => { api.get('/settings/me/notifications').then((r) => { setPrefs(r.data.data); setGmail(!!r.data.delivery?.gmail) }).catch(() => setPrefs({})) }, [])
  if (!prefs) return <p className="text-sm text-gray-400">Loading…</p>
  const toggle = async (k) => {
    const next = { ...prefs, [k]: !prefs[k] }; setPrefs(next)
    try { await api.put('/settings/me/notifications', next); setNote('Saved'); setTimeout(() => setNote(''), 1500) } catch { setNote('Could not save') }
  }
  return (
    <div className="max-w-xl" data-tab-notifications>
      <div className={`rounded-lg border px-3 py-2 text-xs mb-4 ${gmail ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-amber-50 border-amber-200 text-amber-800'}`} data-delivery={gmail ? 'on' : 'off'}>
        {gmail ? 'Email delivery is connected: these go out from the Team mailbox.' : 'Your choices are saved now. Sending starts when a Team mailbox is connected under Label settings › Integrations › Mail — nothing is emailed yet.'}
      </div>
      <ul className="divide-y divide-divider border border-rule rounded-lg">
        {Object.entries(NOTIFY_LABELS).map(([k, [label, body]]) => (
          <li key={k} className="px-4 py-3 flex items-start gap-3">
            <input type="checkbox" checked={!!prefs[k]} onChange={() => toggle(k)} className="mt-1" style={{ accentColor: '#334155' }} data-notify={k} />
            <div><p className="text-sm font-medium text-gray-900">{label}</p><p className="text-xs text-gray-500">{body}</p></div>
          </li>
        ))}
      </ul>
      {note && <p className="text-xs text-gray-500 mt-2" data-note>{note}</p>}
    </div>
  )
}

// ─── My Nav Tab ──────────────────────────────────────────────────────────────

function MyNavTab() {
  const { user, canView, refreshUser } = useAuth()
  // On the ACCOUNT since 2026-09-22 (users.nav_hidden) — a Superadmin can set it
  // for you, and it follows you across devices. localStorage is the cache the
  // sidebar paints from before /auth/me answers.
  const [hiddenPages, setHiddenPages] = useState(() => {
    if (Array.isArray(user?.nav_hidden)) return user.nav_hidden
    try { return JSON.parse(localStorage.getItem('nav_hidden_pages') || '[]') } catch { return [] }
  })
  const [note, setNote] = useState('')
  const write = async (next) => {
    setHiddenPages(next)
    try { localStorage.setItem('nav_hidden_pages', JSON.stringify(next)) } catch { /* private mode */ }
    try { await api.put('/settings/me', { nav_hidden: next }); refreshUser && refreshUser(); setNote('Saved') } catch (e) { setNote(e?.response?.data?.error || 'Could not save') }
    setTimeout(() => setNote(''), 2000)
  }
  const togglePage = (path) => write(hiddenPages.includes(path) ? hiddenPages.filter((p) => p !== path) : [...hiddenPages, path])
  const resetAll = () => write([])
  const drawn = ALL_PAGES.filter(p => !p.hidden && canView(p.path))
  const visibleCount = drawn.filter(p => !hiddenPages.includes(p.path)).length
  return (
    <div data-mynav>
      <div className="flex items-center justify-between mb-5">
        <div>
          <p className="text-sm text-gray-500">{visibleCount} of {drawn.length} pages shown in your nav.</p>
          <p className="text-[11px] text-gray-400 mt-0.5">Untick a page to take it off your sidebar. Pages reached from Settings or from other pages are not listed; they stay reachable. Saved to your account.{note ? ` ${note}.` : ''}</p>
        </div>
        {hiddenPages.length > 0 && (
          <button onClick={resetAll} className="text-xs font-semibold text-boom-600 hover:text-boom-700 px-3 py-1.5 rounded-lg border border-boom-200 hover:bg-boom-50 transition-colors" data-mynav-showall>
            Show all
          </button>
        )}
      </div>
      <NavGrid pages={drawn} granted={null} hidden={new Set(hiddenPages)} onShow={togglePage} testId="mynav" />
    </div>
  )
}

// ─── Theme Tab ───────────────────────────────────────────────────────────────

function ThemeTab() {
  const { theme, setTheme: applyTheme } = useTheme()

  const options = [
    { id: 'light', label: 'Light', desc: 'Clean and bright', icon: Sun },
    { id: 'dark',  label: 'Dark',  desc: 'Easy on the eyes', icon: Moon },
  ]

  return (
    <div>
      <p className="text-sm text-gray-500 mb-5">Choose your preferred appearance.</p>
      <div className="grid grid-cols-2 gap-4 max-w-md">
        {options.map(opt => {
          const Icon = opt.icon
          const active = theme === opt.id
          return (
            <button
              key={opt.id}
              onClick={() => applyTheme(opt.id)}
              className={`flex flex-col items-center gap-3 p-6 rounded-xl border-2 transition-all ${
                active
                  ? 'border-boom-500 bg-boom-50 dark:bg-boom-950/30'
                  : 'border-rule hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600'
              }`}
            >
              <div className={`w-12 h-12 rounded-full flex items-center justify-center ${
                opt.id === 'dark' ? 'bg-gray-900' : 'bg-amber-50 border border-amber-200'
              }`}>
                <Icon size={22} className={opt.id === 'dark' ? 'text-gray-300' : 'text-amber-500'} />
              </div>
              <div className="text-center">
                <p className={`text-sm font-bold ${active ? 'text-boom-700 dark:text-boom-400' : 'text-gray-800 dark:text-gray-200'}`}>{opt.label}</p>
                <p className="text-xs text-gray-400 mt-0.5">{opt.desc}</p>
              </div>
              {active && (
                <span className="text-[10px] font-bold text-boom-600 bg-boom-100 dark:bg-boom-900/30 px-2 py-0.5 rounded-full">Active</span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function ArchiveTab() {
  const [confirming, setConfirming] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [startedAt, setStartedAt] = useState(null)

  const startExport = () => {
    setConfirming(false)
    setDownloading(true)
    setStartedAt(Date.now())
    // The browser streams the ZIP directly to disk via a hidden anchor —
    // anything that goes through axios + responseType:'blob' would buffer the
    // whole archive in JS memory first, which can easily exceed 1 GB.
    const token = localStorage.getItem('token')
    const url = `/api/full-export?token=${encodeURIComponent(token)}`
    const a = document.createElement('a')
    a.href = url
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    // We have no end-of-download signal from the browser, so leave the
    // "preparing" state up for a generous window and then reset.
    setTimeout(() => setDownloading(false), 90_000)
  }

  const sections = [
    { title: 'Bookkeeping', items: 'Ledger, vendors, recoupments, bulk deals, outgoing invoices, audit log, plus every invoice / proof / W9 / receipt file' },
    { title: 'Roster',      items: 'All artists with rollup counts, plus uploaded artist documents' },
    { title: 'Contracts',   items: 'Active contracts, pending contracts, deal pipeline, NDAs, plus every contract / deal file' },
    { title: 'Admin Docs',  items: 'Legal, HR, IP, compliance, and policy vault with files' },
  ]

  return (
    <div className="max-w-3xl">
      <div className="rounded-2xl border border-rule bg-card overflow-hidden shadow-sm">
        {/* Header band */}
        <div className="flex items-start gap-4 p-6 border-b border-rule bg-gradient-to-br from-boom-50 to-white dark:from-boom-950/30 dark:to-transparent">
          <div className="shrink-0 w-12 h-12 rounded-xl bg-boom-600 text-white flex items-center justify-center shadow-sm">
            <FolderArchive size={22} strokeWidth={2} />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">Full Archive Export</h2>
            <p className="text-sm text-gray-500 mt-1">
              One ZIP focused on the ledger plus every invoice, proof of payment, W9/W8, and contract file in the system. Roster and admin docs included for context.
            </p>
          </div>
        </div>

        {/* What's included */}
        <div className="p-6">
          <p className="text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-3 flex items-center gap-2">
            <FileSpreadsheet size={13} /> What you'll get
          </p>
          <div className="grid sm:grid-cols-2 gap-x-6 gap-y-3 mb-6">
            {sections.map((s, i) => (
              <div key={s.title} className="flex items-start gap-3">
                <span className="shrink-0 mt-0.5 w-5 h-5 rounded-md bg-boom-100 dark:bg-boom-900/40 text-boom-700 dark:text-boom-300 text-[10px] font-bold flex items-center justify-center">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-800 dark:text-gray-200">{s.title}</p>
                  <p className="text-xs text-gray-500 leading-snug">{s.items}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900/50 px-4 py-3 mb-6 flex items-start gap-3">
            <AlertTriangle size={16} className="shrink-0 mt-0.5 text-amber-600" />
            <div className="text-xs text-amber-900 dark:text-amber-200 leading-snug">
              The archive can run to <strong>several gigabytes</strong> and the export may take a few minutes. Stay on this page until the file appears in your downloads. The data is not modified — this is a read-only snapshot.
            </div>
          </div>

          <button
            onClick={() => setConfirming(true)}
            disabled={downloading}
            className="inline-flex items-center gap-2.5 px-5 py-3 rounded-xl bg-boom-600 hover:bg-boom-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm font-semibold shadow-sm transition-colors"
          >
            {downloading ? <Loader size={16} className="animate-spin" /> : <Download size={16} />}
            {downloading ? 'Preparing your archive…' : 'Export everything'}
          </button>

          {downloading && (
            <div className="mt-4 text-xs text-gray-500">
              Started {startedAt ? new Date(startedAt).toLocaleTimeString() : ''} · Your browser will save the file when it's ready. You can leave this tab open.
            </div>
          )}
        </div>
      </div>

      {/* Confirmation modal */}
      {confirming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay backdrop-blur-sm p-4" onClick={() => setConfirming(false)}>
          <div className="bg-card rounded-2xl shadow-xl border border-rule max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg bg-boom-100 dark:bg-boom-900/30 text-boom-700 dark:text-boom-400 flex items-center justify-center">
                <Archive size={18} />
              </div>
              <div>
                <h3 className="text-base font-bold text-gray-900 dark:text-gray-100">Confirm full export</h3>
                <p className="text-xs text-gray-500">A complete snapshot of the system</p>
              </div>
            </div>
            <p className="text-sm text-gray-600 dark:text-gray-300 mb-5 leading-relaxed">
              You're about to download an archive containing every record and document file accessible to Superadmin. This is intended for permanent off-platform backup or end-of-tenure handoff.
            </p>
            <p className="text-xs text-gray-500 mb-6">Treat the resulting file as highly confidential.</p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirming(false)}
                className="px-4 py-2 rounded-lg text-sm font-semibold text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={startExport}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-boom-600 hover:bg-boom-700 text-white text-sm font-semibold shadow-sm transition-colors"
              >
                <Download size={14} />
                Start export
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main Settings Page ───────────────────────────────────────────────────────
// The rail (components/SettingsShell.jsx) owns navigation; this renders the
// tab named by ?tab= and a heading that says what the tab is for.
const TAB_META = {
  profile:       ['Profile', 'How your name appears across the app.'],
  signin:        ['Sign-in', 'Your password and where you are signed in.'],
  notifications: ['Notifications', 'Which events email you, once a Team mailbox is connected.'],
  mailbox:       ['My mailbox', 'Send as yourself from the app.'],
  theme:         ['Theme', 'Light, dark, or follow the system.'],
  mynav:         ['My Nav', 'Which pages appear in your sidebar.'],
  label:         ['Label', 'What prints on invoices, NDAs and waivers.'],
  integrations:  ['Integrations', 'What is connected, and what each one powers.'],
  roles:         ['Roles', 'What each role can do — and what only a Superadmin can.'],
  navs:          ['Navs', 'What each department sees: the pages a group gets, and which stay off the sidebar.'],
  archive:       ['Archive', 'Archived releases and artists.'],
}
export default function Settings() {
  const { user, refreshUser } = useAuth()
  const currentUserRole = user?.role
  const isAdmin = currentUserRole === 'Admin' || currentUserRole === 'Superadmin'
  const [searchParams] = useSearchParams()
  const wanted = searchParams.get('tab') || 'profile'
  const allowed = new Set(['profile', 'signin', 'notifications', 'mailbox', 'theme', 'mynav', ...(isAdmin ? ['label', 'integrations', 'roles'] : []), ...(currentUserRole === 'Superadmin' ? ['archive', 'navs'] : [])])
  const tab = allowed.has(wanted) ? wanted : 'profile'
  const [title, subtitle] = TAB_META[tab]
  return (
    <div data-settings-content={tab}>
      <div className="mb-5">
        <h1 className="text-xl font-bold text-gray-900 tracking-tight">{title}</h1>
        <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>
      </div>
      {tab === 'profile'       && <ProfileTab onSaved={() => refreshUser && refreshUser()} />}
      {tab === 'signin'        && <SignInTab />}
      {tab === 'notifications' && <NotificationsTab />}
      {tab === 'mailbox'       && <MyMailbox />}
      {tab === 'theme'         && <ThemeTab />}
      {tab === 'mynav'         && <MyNavTab />}
      {tab === 'label'         && isAdmin && <LabelTab />}
      {tab === 'roles'         && isAdmin && <RolesTab />}
      {tab === 'integrations'  && isAdmin && <IntegrationsTab />}
      {tab === 'archive'       && currentUserRole === 'Superadmin' && <ArchiveTab />}
      {tab === 'navs'          && currentUserRole === 'Superadmin' && <DepartmentNavsTab />}
    </div>
  )
}

// ─── Label — what prints on invoices, NDAs and waivers ──────────────────────
const LABEL_FIELDS = [
  ['Identity', [['legal_name', 'Legal name', 'as it appears on contracts and the W-9'], ['display_name', 'Display name', 'how the label is written in emails and headers'], ['default_payment_terms', 'Default payment terms', 'e.g. Net 30']]],
  ['Address', [['address_line1', 'Address line 1'], ['address_line2', 'Address line 2', 'city, state, ZIP']]],
  ['Contact', [['contact_name', 'Contact name'], ['contact_email', 'Contact email'], ['contact_phone', 'Contact phone']]],
  ['Signatory', [['signatory_name', 'Signatory name', 'signs NDAs and waivers; countersigns DocuSign envelopes'], ['signatory_title', 'Signatory title', 'e.g. Managing Member'], ['signatory_email', 'Signatory email', 'where DocuSign sends the countersignature request']]],
  ['Remittance bank', [['bank_name', 'Bank name'], ['bank_address', 'Bank address'], ['bank_account_name', 'Name on the account'], ['bank_account_type', 'Account type', 'Checking or Savings'], ['bank_routing_ach', 'Routing (ACH)'], ['bank_routing_wire', 'Routing (wire)'], ['bank_swift', 'SWIFT / BIC']]],
]
function LabelTab() {
  const { user } = useAuth()
  const isSuper = user?.role === 'Superadmin'
  const [row, setRow] = useState(null)
  const [form, setForm] = useState(null)
  const [secrets, setSecrets] = useState({ ein: '', bank_account_number: '' })
  const [saving, setSaving] = useState(false); const [note, setNote] = useState(''); const [err, setErr] = useState('')
  useEffect(() => {
    api.get('/label').then((r) => {
      const d = r.data.data || {}
      setRow(d)
      setForm(Object.fromEntries(LABEL_FIELDS.flatMap(([, fs]) => fs.map(([k]) => [k, d[k] || '']))))
    }).catch(() => setErr('Could not load the label'))
  }, [])
  if (!form) return <p className="text-sm text-gray-400">{err || 'Loading…'}</p>
  const save = async (e) => {
    e.preventDefault(); setSaving(true); setErr(''); setNote('')
    try {
      const body = { ...form }
      if (isSuper && secrets.ein.trim()) body.ein = secrets.ein.trim()
      if (isSuper && secrets.bank_account_number.trim()) body.bank_account_number = secrets.bank_account_number.trim()
      const r = await api.put('/label', body)
      setRow(r.data.data); setSecrets({ ein: '', bank_account_number: '' }); setNote('Saved. Documents print these from now on.'); refreshLabel()
    } catch (e2) { setErr(e2?.response?.data?.error || 'Could not save') }
    finally { setSaving(false); setTimeout(() => setNote(''), 4000) }
  }
  const blanks = (fields) => fields.filter(([k]) => !form[k] && k !== 'address_line2').length
  const secretBlanks = (row?.ein_set ? 0 : 1) + (row?.bank_account_set ? 0 : 1)
  const missing = LABEL_FIELDS.reduce((t, [, fs]) => t + blanks(fs), 0) + secretBlanks
  const up = (v) => String(v || '').toUpperCase()
  const or = (v, dash = '—') => (v ? v : <span className="text-rose-400">{dash}</span>)
  return (
    <form onSubmit={save} className="lg:grid lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-8" data-tab-label>
      <div className="space-y-4">
        <div className={`rounded-lg border px-3 py-2 text-xs ${missing ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-emerald-50 border-emerald-200 text-emerald-800'}`} data-label-status>
          {missing ? `${missing} field${missing === 1 ? '' : 's'} still blank. Blank fields print as blank on invoices, NDAs and waivers.` : 'Every field is filled. Invoices, NDAs and waivers print from this record.'}
        </div>
        {LABEL_FIELDS.map(([section, fields]) => {
          const b = blanks(fields)
          return (
            <div key={section} className="card p-4" data-label-section={section}>
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-semibold text-gray-900">{section}</p>
                <span className={`text-[11px] font-medium ${b ? 'text-amber-700' : 'text-emerald-700'}`}>{b ? `${b} blank` : 'complete'}</span>
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                {fields.map(([k, label, hint]) => (
                  <label key={k} className={`block ${/address|bank_address/.test(k) ? 'sm:col-span-2' : ''}`}>
                    <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">{label}</span>
                    <input value={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} placeholder={hint || ''} className="input-base w-full mt-1" data-label-field={k} />
                  </label>
                ))}
              </div>
            </div>
          )
        })}
        <div className="card p-4" data-label-section="Numbers">
          <div className="flex items-center justify-between mb-1">
            <p className="text-sm font-semibold text-gray-900">Numbers · encrypted</p>
            <span className={`text-[11px] font-medium ${secretBlanks ? 'text-amber-700' : 'text-emerald-700'}`}>{secretBlanks ? `${secretBlanks} not on file` : 'both on file'}</span>
          </div>
          <p className="text-[11px] text-gray-400 mb-3">Stored encrypted. Only the last four digits are shown again; the full numbers print on an invoice through an audited read by a bookkeeping role.{isSuper ? '' : ' Only a Superadmin can change them.'}</p>
          <div className="grid sm:grid-cols-2 gap-3">
            {[['ein', 'EIN', row?.ein_set ? `on file · ending ${row.ein_last4}` : 'not on file'], ['bank_account_number', 'Bank account number', row?.bank_account_set ? `on file · ending ${row.bank_account_last4}` : 'not on file']].map(([k, label, status]) => (
              <label key={k} className="block">
                <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">{label} <span className="text-gray-400 normal-case font-normal tracking-normal ml-1" data-secret-status={k}>{status}</span></span>
                <input value={secrets[k]} onChange={(e) => setSecrets((x) => ({ ...x, [k]: e.target.value }))} placeholder={isSuper ? (row?.[k === 'ein' ? 'ein_set' : 'bank_account_set'] ? 'type to replace' : 'type to set') : 'Superadmin only'} disabled={!isSuper} autoComplete="off" className="input-base w-full mt-1 disabled:opacity-50" data-secret-field={k} />
              </label>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button type="submit" disabled={saving} className="btn-primary text-sm px-4 py-2">{saving ? 'Saving…' : 'Save label details'}</button>
          {note && <span className="text-xs text-emerald-700" data-note>{note}</span>}
          {err && <span className="text-xs text-rose-600" data-error>{err}</span>}
        </div>
      </div>

      {/* Live preview — what these fields become on the documents */}
      <aside className="mt-6 lg:mt-0 space-y-4 lg:sticky lg:top-6 lg:self-start" data-label-preview>
        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">As it prints</p>
        <div className="card p-4 font-mono text-[11px] leading-relaxed text-gray-800">
          <p className="text-[9px] font-sans font-bold text-gray-400 uppercase tracking-wider mb-2">Invoice · funds payable to</p>
          <p>{or(up(form.legal_name || form.display_name), 'LEGAL NAME')}</p>
          <p>{or(up(form.address_line1), 'ADDRESS')}</p>
          {form.address_line2 && <p>{up(form.address_line2)}</p>}
          <p className="mt-2">CONTACT: {or(up(form.contact_name))}</p>
          <p>PHONE: {or(form.contact_phone)}</p>
          <p>EMAIL: {or(form.contact_email)}</p>
          <p className="mt-2 pt-2 border-t border-divider">EIN: {row?.ein_set ? `••-•••${row.ein_last4}` : <span className="text-rose-400">—</span>}</p>
          <p className="mt-2 pt-2 border-t border-divider">BANK: {or(up(form.bank_name))}</p>
          <p>ADDRESS: {or(up(form.bank_address))}</p>
          <p>NAME: {or(up(form.bank_account_name))}</p>
          <p>TYPE: {or(up(form.bank_account_type))}</p>
          <p>SWIFT: {or(form.bank_swift)}</p>
          <p>ROUTING: {or(form.bank_routing_wire)} <span className="text-gray-400">wire</span></p>
          <p className="pl-[62px]">{or(form.bank_routing_ach)} <span className="text-gray-400">ach</span></p>
          <p>ACCOUNT: {row?.bank_account_set ? `••••${row.bank_account_last4}` : <span className="text-rose-400">—</span>}</p>
        </div>
        <div className="card p-4 text-[12px] leading-relaxed text-gray-800">
          <p className="text-[9px] font-bold text-gray-400 uppercase tracking-wider mb-2">NDA · signature</p>
          <p className="font-semibold">{or(form.legal_name || form.display_name, 'Legal name')}</p>
          <p className="text-gray-500">{or([form.address_line1, form.address_line2].filter(Boolean).join(', '), 'address')}</p>
          <p className="mt-3">By: ____________________</p>
          <p>{or(form.signatory_name, 'Signatory name')}, {or(form.signatory_title, 'title')}</p>
          <p className="mt-3 text-[11px] text-gray-500">Payment terms on new invoices: <span className="text-gray-800">{or(form.default_payment_terms)}</span></p>
        </div>
        <p className="text-[11px] text-gray-400">Red dashes are blanks. The invoice generator and the NDA form read this record the moment it is saved.</p>
      </aside>
    </form>
  )
}

// ─── Integrations — status only; keys live in Railway ───────────────────────
// ─── Roles — described from the code that enforces them (lib/roles.js) ────
const ROLE_TONE = { Superadmin: 'bg-purple-50 text-purple-700 border-purple-200', Admin: 'bg-blue-50 text-blue-700 border-blue-200', Approver: 'bg-emerald-50 text-emerald-700 border-emerald-200', User: 'bg-gray-50 text-gray-700 border-gray-200' }
function RolesTab() {
  return (
    <div className="max-w-3xl space-y-6" data-tab-roles>
      <p className="text-sm text-gray-600">A role is what a person may <em>do</em>. Which pages they can <em>open</em> is set separately on their profile under People. Superadmin and Admin differ in three ways: only a Superadmin manages other admins, writes the label's EIN and bank account, and can view the app as someone else.</p>
      <div className="grid gap-4 md:grid-cols-2">
        {ROLES.map((r) => (
          <div key={r.id} className="card p-4 space-y-3" data-role-card={r.id}>
            <div>
              <span className={`inline-block text-[11px] font-bold px-2 py-0.5 rounded-full border ${ROLE_TONE[r.id]}`}>{r.id}</span>
              <p className="text-sm font-semibold text-gray-900 mt-2">{r.short}</p>
              <p className="text-xs text-gray-500 mt-0.5">{r.who}</p>
            </div>
            <div>
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Can</p>
              <ul className="text-xs text-gray-700 space-y-1 list-disc pl-4">{r.can.map((c) => <li key={c}>{c}</li>)}</ul>
            </div>
            {r.cannot?.length > 0 && (
              <div>
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Cannot</p>
                <ul className="text-xs text-gray-500 space-y-1 list-disc pl-4">{r.cannot.map((c) => <li key={c}>{c}</li>)}</ul>
              </div>
            )}
            <p className="text-[11px] text-gray-500 border-t border-divider pt-2"><span className="font-semibold text-gray-700">Pages:</span> {r.pages}</p>
          </div>
        ))}
      </div>
      <div className="card p-4" data-role-axes>
        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">Four things that are not the same</p>
        <dl className="grid sm:grid-cols-[140px_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
          {AXES.map(([k, v]) => (<Fragment key={k}><dt className="font-semibold text-gray-900">{k}</dt><dd className="text-gray-600">{v}</dd></Fragment>))}
        </dl>
        <p className="text-[11px] text-gray-400 mt-3">Change a role on the person's profile under People. Only a Superadmin can hand out Admin or Superadmin.</p>
      </div>
    </div>
  )
}

function IntegrationsTab() {
  const [rows, setRows] = useState(null)
  useEffect(() => { api.get('/settings/integrations').then((r) => setRows(r.data.data || [])).catch(() => setRows([])) }, [])
  if (!rows) return <p className="text-sm text-gray-400">Loading…</p>
  const off = rows.filter((r) => !r.configured).length
  return (
    <div className="max-w-2xl space-y-4" data-tab-integrations>
      <MailCard />
      <QuickBooksCard />
      <DocuSignCard />
      <p className="text-xs text-gray-500 mb-3">{off ? `${off} of ${rows.length} not configured. ` : 'Everything is configured. '}Read from the server's environment; nothing here accepts a key. Keys are set on Railway.</p>
      <ul className="divide-y divide-divider border border-rule rounded-lg">
        {rows.map((r) => (
          <li key={r.key} className="px-4 py-3 flex items-start gap-3" data-integration={r.key} data-configured={r.configured ? '1' : '0'}>
            <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${r.configured ? 'bg-emerald-500' : 'bg-gray-300'}`} />
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-2 flex-wrap">
                <p className="text-sm font-semibold text-gray-900">{r.label}</p>
                <span className={`text-[11px] font-semibold ${r.configured ? 'text-emerald-700' : 'text-gray-400'}`}>{r.configured ? 'configured' : 'not configured'}</span>
                {r.detail && <span className="text-[11px] text-gray-400">· {r.detail}</span>}
                {r.last_used && <span className="text-[11px] text-gray-400">· last used {new Date(r.last_used).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>}
              </div>
              <p className="text-xs text-gray-500">{r.configured ? 'Powers' : 'Without it there are no'} {r.powers}.</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
