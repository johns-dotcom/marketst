import { useState, useEffect } from 'react'
import { Users, Shield, Plus, Pencil, Trash2, X, Loader, CheckCircle2, Check, SlidersHorizontal, Sun, Moon, Monitor, FlaskConical, Archive, Download, FileSpreadsheet, FolderArchive, AlertTriangle, EyeOff, Search, ChevronRight, ChevronDown } from 'lucide-react'
import api from '../api'
import { NAV_PAGES } from '../navConfig'
import { PRESETS, DEPARTMENTS, presetsForDepartment, unionPaths, addPaths } from '../lib/navPresets'
import { useBoomReps, useBoomRepsContext } from '../context/BoomRepsContext'
import { useAuth } from '../context/AuthContext'
import { useTheme } from '../context/ThemeContext'
import EmailPreviewModal from '../components/EmailPreviewModal'
import PageHeader from '../components/PageHeader'
import useHotkeys from '../hooks/useHotkeys'

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
const ALL_ROLES = ['Superadmin', 'Admin', 'Approver', 'User']
const ROLES = ['Admin', 'User'] // shown to regular Admins
// Departments and role presets live in lib/navPresets.js — one definition,
// read by the user form (default tick from department), the Permissions
// editor (additive apply) and client/scripts/navpresets-fixture.mjs.

const PAGE_GROUPS = [...new Set(ALL_PAGES.map(p => p.group))]

// ─── User Form Modal ──────────────────────────────────────────────────────────

// ─── Market Street Reps management panel ─────────────────────────────────────────────
// Curate the list of reps used by every "Market Street Rep" dropdown in the app
// (Approvals filter, Payments filter, Ledger inline edit, user assignment,
// vendor submit form, etc.). Deactivating a rep just hides them from new
// dropdowns — historical entries that reference the name still work.
function BoomRepsPanel() {
  const [rows, setRows] = useState(null)  // null = loading
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { refresh: refreshRepsContext } = useBoomRepsContext()

  const load = async () => {
    try {
      const res = await api.get('/settings/reps')
      setRows(res.data?.data || [])
    } catch (err) {
      console.error('Failed to load reps:', err?.response?.data?.error || err.message)
      setRows([])
    }
  }
  useEffect(() => { load() }, [])

  const add = async () => {
    const name = newName.trim()
    if (!name) return
    setBusy(true)
    setError('')
    try {
      await api.post('/settings/reps', { name })
      setNewName('')
      await load()
      // Sync the global context so every page picks up the new rep
      // without a reload.
      refreshRepsContext()
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to add rep')
    } finally { setBusy(false) }
  }
  const toggle = async (name, active) => {
    setBusy(true)
    setError('')
    try {
      await api.patch(`/settings/reps/${encodeURIComponent(name)}`, { active })
      await load()
      refreshRepsContext()
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to update rep')
    } finally { setBusy(false) }
  }

  return (
    <div className="mt-8 pt-6 border-t border-rule">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-bold text-gray-800">Market Street Reps</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Curates the list that appears in every Market Street Rep dropdown across the app. Deactivate to hide a rep from new entries without affecting historical references.
          </p>
        </div>
      </div>
      {error && (
        <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 mb-3">
          {error}
        </div>
      )}
      {/* Add row */}
      <div className="flex items-center gap-2 mb-3">
        <input
          type="text"
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
          placeholder="New rep name"
          disabled={busy}
          className="text-sm border border-rule rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-boom-400 bg-card flex-1 max-w-[260px] disabled:opacity-50"
        />
        <button
          onClick={add}
          disabled={busy || !newName.trim()}
          className="text-xs font-semibold bg-gray-900 text-white px-4 py-2 rounded-lg hover:bg-gray-800 transition-colors disabled:opacity-40 inline-flex items-center gap-1.5"
        >
          <Plus size={13} /> Add rep
        </button>
      </div>
      {/* List */}
      {rows == null ? (
        <p className="text-xs text-gray-400">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-gray-400">No reps configured.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {rows.map(r => (
            <div
              key={r.name}
              className={`inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-xs font-semibold border ${
                r.active
                  ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                  : 'bg-gray-100 text-gray-500 border-gray-200'
              }`}
              title={r.created_by_name ? `Added by ${r.created_by_name}` : 'Seeded rep'}
            >
              <span className={r.active ? '' : 'line-through'}>{r.name}</span>
              <button
                onClick={() => toggle(r.name, !r.active)}
                disabled={busy}
                className={`text-[10px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded ${
                  r.active
                    ? 'text-emerald-700 hover:bg-emerald-100'
                    : 'text-gray-600 hover:bg-gray-200'
                } disabled:opacity-50`}
                title={r.active ? 'Deactivate — hides from dropdowns' : 'Reactivate'}
              >
                {r.active ? 'On' : 'Off'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function UserModal({ user, onClose, onSaved, currentUserRole }) {
  const isEdit = !!user
  const availableRoles = currentUserRole === 'Superadmin' ? ALL_ROLES : ROLES
  const BOOM_REPS = useBoomReps()
  const { refresh: refreshRepsContext } = useBoomRepsContext()
  const [form, setForm] = useState({
    name:            user?.name            ?? '',
    email:           user?.email           ?? '',
    role:            user?.role            ?? 'User',
    department:      user?.department      ?? 'Operations',
    hierarchy_level: user?.hierarchy_level ?? 99,
    boom_rep:        user?.boom_rep        ?? '',
    password:        '',
  })
  // Whether this user is currently in the active boom_reps list. Seeded
  // from the existing BOOM_REPS array — a user is "a rep" when their
  // exact name (case-insensitive) matches an active rep row.
  const initialIsRep = !!(user?.name && BOOM_REPS.some(r => r.toLowerCase() === user.name.toLowerCase()))
  const [isRep, setIsRep] = useState(initialIsRep)
  const [repToggling, setRepToggling] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  // Page permissions (for new users only)
  //
  // Defaults to a PRESET, not to "unrestricted". For a User the two are
  // opposites: unrestricted stores no permission rows, and the model is
  // default-CLOSED, so no rows means the Dashboard and Settings and nothing
  // else. Two live accounts sit in exactly that state — created, never
  // configured, and looking at a two-link app ever since.
  const [unrestricted, setUnrestricted] = useState(false)
  // Presets are ADDITIVE (lib/navPresets.js): the department seeds the default
  // tick, the admin can tick a second one for somebody who does two jobs, and
  // the page set is the union. Ticking rewrites the checkboxes below; the
  // admin can still adjust single pages afterwards.
  const [presetKeys, setPresetKeys] = useState(() => new Set(presetsForDepartment(user?.department ?? 'Operations')))
  const [allowedPages, setAllowedPages] = useState(() => new Set(unionPaths(presetsForDepartment(user?.department ?? 'Operations'))))
  const togglePreset = (key) => {
    const next = new Set(presetKeys)
    next.has(key) ? next.delete(key) : next.add(key)
    setPresetKeys(next)
    setAllowedPages(new Set(unionPaths([...next])))
  }
  const setDepartment = (d) => {
    set('department', d)
    if (isEdit) return
    const keys = new Set(presetsForDepartment(d))
    setPresetKeys(keys)
    setAllowedPages(new Set(unionPaths([...keys])))
  }

  const togglePage = (path) => {
    setAllowedPages(prev => {
      const next = new Set(prev)
      next.has(path) ? next.delete(path) : next.add(path)
      return next
    })
  }
  const selectAllPages = () => setAllowedPages(new Set(ALL_PAGES.map(p => p.path)))
  const deselectAllPages = () => setAllowedPages(new Set())

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const submit = async () => {
    if (!form.name.trim() || !form.email.trim()) {
      setError('Name and email are required.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      let userId
      if (isEdit) {
        const payload = {
          name: form.name, email: form.email, role: form.role,
          department: form.department, hierarchy_level: Number(form.hierarchy_level),
          // Always send boom_rep so admins can both set AND clear the
          // assignment. Empty string → server clears to NULL.
          boom_rep: form.boom_rep || '',
        }
        if (form.password.trim()) payload.password = form.password
        const res = await api.put(`/settings/users/${user.id}`, payload)
        userId = user.id
        onSaved(res.data.data)
      } else {
        const res = await api.post('/settings/users', {
          name: form.name,
          email: form.email,
          role: form.role,
          department: form.department,
          hierarchy_level: Number(form.hierarchy_level),
          boom_rep: form.boom_rep || '',
          // Grant the starting pages in the SAME request that creates the
          // account. The follow-up PUT below only fires for role 'User' with the
          // box unticked, which is why an Approver created in a hurry ends up
          // with no rows at all.
          pages: (form.role === 'Admin' || form.role === 'Superadmin' || unrestricted)
            ? [] : Array.from(allowedPages),
        })
        userId = res.data.data.id
        onSaved(res.data.data, res.data.pending_email || null)
      }

      // Save permissions for non-admin new users
      if (!isEdit && form.role === 'User' && !unrestricted && userId) {
        await api.put(`/settings/permissions/${userId}`, {
          pages: Array.from(allowedPages),
        }).catch(() => {})
      }

      onClose()
    } catch (err) {
      setError(err.response?.data?.error || 'Something went wrong.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="bg-card rounded-2xl shadow-2xl border border-divider w-[480px] max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-divider">
          <h3 className="text-sm font-bold text-gray-900">{isEdit ? 'Edit User' : 'Add User'}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 transition-colors">
            <X size={16} />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Name</label>
              <input
                type="text"
                value={form.name}
                onChange={e => set('name', e.target.value)}
                placeholder="Full name"
                className="w-full text-sm border border-rule rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-boom-400 placeholder:text-gray-300"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Email</label>
              <input
                type="email"
                value={form.email}
                onChange={e => set('email', e.target.value)}
                placeholder="email@deanst.co"
                className="w-full text-sm border border-rule rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-boom-400 placeholder:text-gray-300"
              />
            </div>
          </div>

          {isEdit && (
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
                New Password (leave blank to keep current)
              </label>
              <input
                type="password"
                value={form.password}
                onChange={e => set('password', e.target.value)}
                placeholder="Leave blank to keep current password"
                className="w-full text-sm border border-rule rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-boom-400 placeholder:text-gray-300"
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Role</label>
              <select
                value={form.role}
                onChange={e => set('role', e.target.value)}
                className="w-full text-sm border border-rule rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-boom-400 bg-card"
              >
                {availableRoles.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
              <p className="text-[11px] text-gray-500 mt-1.5 leading-snug">
                {form.role === 'Superadmin' && 'Full access everywhere + can grant any role.'}
                {form.role === 'Admin' && 'Full app access. Can manage users and grant Admin/User roles.'}
                {form.role === 'Approver' && 'Bookkeeping admin — full Approvals page (approve, reject, edit, split, aliases). No user management or app-level deletes.'}
                {form.role === 'User' && 'Sees only the pages explicitly granted below. Expenses they create go to pending.'}
              </p>
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Department</label>
              <select
                value={form.department}
                onChange={e => setDepartment(e.target.value)}
                className="w-full text-sm border border-rule rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-boom-400 bg-card"
              >
                {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
          </div>

          {/* Market Street Rep — two related-but-distinct concepts:
              1. Identity  — is this user themselves a rep? Ticking the
                 checkbox adds their name to boom_reps so it appears in
                 every "Market Street Rep" dropdown across the app.
              2. Visibility — which rep's invoices does this user see
                 on Approvals + Payments? Assignable independently. */}
          <div className="border border-rule rounded-xl p-4 space-y-3">
            <div>
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isRep}
                  disabled={repToggling || !form.name.trim()}
                  onChange={async (e) => {
                    const next = e.target.checked
                    const name = form.name.trim()
                    if (!name) return
                    const prev = isRep
                    setIsRep(next)
                    setRepToggling(true)
                    try {
                      if (next) {
                        await api.post('/settings/reps', { name })
                      } else {
                        await api.patch(`/settings/reps/${encodeURIComponent(name)}`, { active: false })
                      }
                      refreshRepsContext()
                    } catch (err) {
                      setIsRep(prev)
                      setError(err?.response?.data?.error || 'Failed to update rep status')
                    } finally {
                      setRepToggling(false)
                    }
                  }}
                  className="mt-0.5 h-4 w-4 rounded border-rule text-boom-600 focus:ring-boom-400 cursor-pointer"
                />
                <div>
                  <div className="text-sm font-semibold text-gray-800">
                    Market Street Rep
                    {repToggling && <span className="text-[10px] text-gray-400 italic ml-2">saving…</span>}
                  </div>
                  <p className="text-[11px] text-gray-500 mt-0.5">
                    Adds their name to every "Market Street Rep" dropdown across the app (Approvals, Payments, Ledger, Vendor Submit). Untick to hide from new entries — historical references still work.
                    {!form.name.trim() && <span className="block text-amber-600 mt-0.5">Enter a name first.</span>}
                  </p>
                </div>
              </label>
            </div>
            <div className="pt-3 border-t border-rule">
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Assigned to (visibility)</label>
              <select
                value={form.boom_rep}
                onChange={e => set('boom_rep', e.target.value)}
                className="w-full text-sm border border-rule rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-boom-400 bg-card"
              >
                <option value="">— None —</option>
                {BOOM_REPS.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
              <p className="text-[11px] text-gray-400 mt-1">
                {form.role === 'Admin' || form.role === 'Superadmin'
                  ? 'Admins / Superadmins see every rep regardless, but you can still assign one to declare the rep persona.'
                  : 'When set, this user automatically sees invoices on Approvals + Payments where the boom_rep matches. Independent of the checkbox above.'}
              </p>
            </div>
          </div>

          {/* Page permissions — only for new non-admin users */}
          {!isEdit && form.role === 'User' && (
            <div className="border border-rule rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Page Permissions</label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={unrestricted}
                    onChange={e => setUnrestricted(e.target.checked)}
                    style={{ accentColor: '#334155' }}
                  />
                  <span className="text-xs text-gray-600 font-medium">
                    No page rows
                    <span className="block text-[10px] font-normal text-gray-400 leading-tight">
                      Leaves permissions unset — a User then sees only the Dashboard
                    </span>
                  </span>
                </label>
              </div>
              {!unrestricted && (
                <div>
                  <div className="flex flex-wrap items-center gap-1.5 mb-2">
                    <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mr-1">Presets</span>
                    {PRESETS.map(pr => {
                      const on = presetKeys.has(pr.key)
                      return (
                        <button
                          key={pr.key}
                          type="button"
                          onClick={() => togglePreset(pr.key)}
                          title={pr.description}
                          aria-pressed={on}
                          className={`text-[11px] font-medium px-2.5 py-1 rounded-full border transition-colors ${
                            on ? 'bg-boom-600 text-white border-boom-600' : 'bg-card text-gray-600 border-rule hover:border-gray-400'
                          }`}
                        >
                          {pr.label}
                        </button>
                      )
                    })}
                  </div>
                  <p className="text-[10px] text-gray-400 mb-2 leading-tight">
                    Tick more than one for somebody who does two jobs — the pages add up. Adjust single pages below.
                  </p>
                  <div className="flex gap-2 mb-2">
                    <button type="button" onClick={selectAllPages} className="text-[10px] font-semibold text-boom-600 hover:text-boom-700">Select all</button>
                    <button type="button" onClick={deselectAllPages} className="text-[10px] font-semibold text-gray-400 hover:text-gray-600">Deselect all</button>
                  </div>
                  <div className="max-h-48 overflow-y-auto space-y-2">
                    {PAGE_GROUPS.map(group => (
                      <div key={group}>
                        <p className="text-[9px] font-bold text-gray-400 uppercase tracking-wider mb-1">{group}</p>
                        <div className="grid grid-cols-2 gap-1">
                          {ALL_PAGES.filter(p => p.group === group).map(page => (
                            <label key={page.path} className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer py-0.5">
                              <input
                                type="checkbox"
                                checked={allowedPages.has(page.path)}
                                onChange={() => togglePage(page.path)}
                                style={{ accentColor: '#334155', width: 13, height: 13 }}
                              />
                              {page.label}
                            </label>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {error && <p className="text-xs text-red-500">{error}</p>}

          <div className="flex gap-3 pt-1">
            <button
              onClick={onClose}
              className="flex-1 text-sm font-semibold text-gray-600 border border-rule py-2.5 rounded-xl hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={saving}
              className="flex-1 text-sm font-semibold bg-gray-900 text-white py-2.5 rounded-xl hover:bg-gray-800 transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
            >
              {saving ? <><Loader size={14} className="animate-spin" /> Saving…</> : (isEdit ? 'Save Changes' : 'Create User')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Confirm Delete Modal ─────────────────────────────────────────────────────

function DeleteConfirm({ user, onClose, onDeleted }) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError]       = useState(null)

  const confirm = async () => {
    setDeleting(true)
    try {
      await api.delete(`/settings/users/${user.id}`)
      onDeleted(user.id)
      onClose()
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete.')
      setDeleting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="bg-card rounded-2xl shadow-2xl border border-divider w-[380px]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-divider">
          <h3 className="text-sm font-bold text-gray-900">Delete User</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 transition-colors">
            <X size={16} />
          </button>
        </div>
        <div className="p-6">
          <p className="text-sm text-gray-700 mb-1">Remove <span className="font-semibold">{user.name}</span> from the dashboard?</p>
          <p className="text-xs text-gray-400 mb-5">This can't be undone. Their activity history will remain in the log.</p>
          {error && <p className="text-xs text-red-500 mb-3">{error}</p>}
          <div className="flex gap-3">
            <button onClick={onClose} className="flex-1 text-sm font-semibold text-gray-600 border border-rule py-2.5 rounded-xl hover:bg-gray-50 transition-colors">
              Cancel
            </button>
            <button
              onClick={confirm}
              disabled={deleting}
              className="flex-1 text-sm font-semibold bg-red-600 text-white py-2.5 rounded-xl hover:bg-red-700 transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
            >
              {deleting ? <><Loader size={14} className="animate-spin" /> Deleting…</> : 'Delete'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Users Tab ────────────────────────────────────────────────────────────────

function UsersTab({ currentUserRole, currentUserId }) {
  const [users, setUsers]       = useState([])
  const [loading, setLoading]   = useState(true)
  const [modal, setModal]       = useState(null)   // null | { type: 'add' | 'edit' | 'delete', user? }
  const [pendingEmail, setPendingEmail] = useState(null)
  const [teamRoster, setTeamRoster] = useState([])
  useEffect(() => {
    api.get('/team').then(r => {
      const list = Array.isArray(r.data?.data) ? r.data.data : (Array.isArray(r.data) ? r.data : [])
      setTeamRoster(list.filter(u => u && u.email))
    }).catch(() => {})
  }, [])

  useHotkeys([
    { key: 'n', handler: () => setModal({ type: 'add' }) },
  ])

  const canManage = (targetUser) => {
    // Superadmin can manage anyone; Admin cannot manage Admin or Superadmin accounts
    if (currentUserRole === 'Superadmin') return true
    return targetUser.role !== 'Admin' && targetUser.role !== 'Superadmin'
  }
  // Users + Admins can't see a delete button on Superadmin rows at all.
  // canManage already blocks them from acting, but hiding the icon makes the
  // affordance match the policy. Also hide for the viewer's own row since
  // the server rejects self-delete.
  const canDelete = (targetUser) => {
    if (targetUser.id === currentUserId) return false
    if (targetUser.role === 'Superadmin' && currentUserRole !== 'Superadmin') return false
    return canManage(targetUser)
  }
  // Last-Superadmin guard mirrored client-side so we don't render a delete
  // affordance the server would reject anyway.
  const superadminCount = users.filter(u => u.role === 'Superadmin').length

  useEffect(() => {
    api.get('/settings/users')
      .then(res => setUsers(res.data.data || []))
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  const handleSaved = (saved, pending = null) => {
    setUsers(prev => {
      const idx = prev.findIndex(u => u.id === saved.id)
      if (idx >= 0) {
        const next = [...prev]
        next[idx] = saved
        return next
      }
      return [...prev, saved]
    })
    if (pending) setPendingEmail(pending)
  }

  const handleDeleted = (id) => {
    setUsers(prev => prev.filter(u => u.id !== id))
  }

  if (loading) return (
    <div className="flex items-center justify-center py-20">
      <div className="w-6 h-6 border-2 border-boom-600 border-t-transparent rounded-full animate-spin" />
    </div>
  )

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <p className="text-sm text-gray-500">{users.length} user{users.length !== 1 ? 's' : ''}</p>
        <button
          onClick={() => setModal({ type: 'add' })}
          className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-gray-900 text-white hover:bg-gray-800 transition-colors"
        >
          <Plus size={13} /> Add User
        </button>
      </div>

      <div className="border border-rule rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-rule">
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Name</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Email</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Role</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Department</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {users.map(u => (
              <tr key={u.id} className="hover:bg-gray-50 transition-colors">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-full bg-boom-100 flex items-center justify-center flex-shrink-0">
                      <span className="text-[11px] font-bold text-boom-700">{u.name?.charAt(0)?.toUpperCase()}</span>
                    </div>
                    <span className="font-medium text-gray-900">{u.name}</span>
                  </div>
                </td>
                <td className="px-4 py-3 text-gray-500">{u.email}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold ${
                    u.role === 'Superadmin'
                      ? 'bg-purple-50 text-purple-700'
                      : u.role === 'Admin'
                      ? 'bg-boom-50 text-boom-700'
                      : u.role === 'Approver'
                      ? 'bg-amber-50 text-amber-700'
                      : 'bg-gray-100 text-gray-600'
                  }`}>
                    {u.role}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-500">{u.department}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1 justify-end">
                    {canManage(u) && (
                      <button
                        onClick={() => setModal({ type: 'edit', user: u })}
                        className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                        title="Edit"
                      >
                        <Pencil size={14} />
                      </button>
                    )}
                    {canDelete(u) && !(u.role === 'Superadmin' && superadminCount <= 1) && (
                      <button
                        onClick={() => setModal({ type: 'delete', user: u })}
                        className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                        title="Delete"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Market Street Reps management — curate the list of reps that populates
          every "Market Street Rep" dropdown across the app. Admin / Superadmin
          only (the whole Users tab is admin-only already). */}
      <BoomRepsPanel />

      {modal?.type === 'add'    && <UserModal currentUserRole={currentUserRole} onClose={() => setModal(null)} onSaved={handleSaved} />}
      {modal?.type === 'edit'   && <UserModal currentUserRole={currentUserRole} user={modal.user} onClose={() => setModal(null)} onSaved={handleSaved} />}
      {modal?.type === 'delete' && <DeleteConfirm user={modal.user} onClose={() => setModal(null)} onDeleted={handleDeleted} />}
      {pendingEmail && (
        <EmailPreviewModal
          open
          title="Send welcome email"
          subtitle={`New user: ${pendingEmail.context?.name || pendingEmail.to}`}
          previewKind={pendingEmail.kind}
          previewContext={pendingEmail.context}
          initialTo={pendingEmail.to}
          initialCc={pendingEmail.cc}
          initialSubject={pendingEmail.subject}
          initialHtml={pendingEmail.html}
          team={teamRoster}
          onClose={() => setPendingEmail(null)}
          onSent={() => setPendingEmail(null)}
          onSkipped={() => setPendingEmail(null)}
          skipLabel="Skip welcome email"
        />
      )}
    </div>
  )
}

// ─── Permissions Tab ──────────────────────────────────────────────────────────

function PermissionsTab({ currentUserRole }) {
  const BOOM_REPS = useBoomReps()
  const [users, setUsers]           = useState([])
  const [selectedId, setSelectedId] = useState('')
  const [allowed, setAllowed]       = useState(null)  // null = loading | Set<string> = configured
  const [unrestricted, setUnrestricted] = useState(true)
  const [loadingPerms, setLoadingPerms] = useState(false)
  const [saving, setSaving]         = useState(false)
  const [saved, setSaved]           = useState(false)
  // Search + collapse state for the per-user editor. Search filters
  // by page label (case-insensitive); collapsedGroups is a Set of
  // group names that are currently collapsed. Groups auto-expand
  // when the search query filters into them.
  const [search, setSearch]         = useState('')
  const [collapsedGroups, setCollapsedGroups] = useState(new Set())
  // "Copy from user" busy state so the button shows a spinner while
  // fetching + merging that user's permissions.
  const [copyBusy, setCopyBusy]     = useState(false)
  // Admin-built templates (server-stored) — listed alongside the
  // hardcoded starter presets in the Apply menu, managed inline below it.
  const [customTemplates, setCustomTemplates] = useState([])
  const [templateBusy, setTemplateBusy] = useState(false)
  const fetchTemplates = () =>
    api.get('/settings/permission-templates')
      .then(res => setCustomTemplates(res.data.data || []))
      .catch(() => {})
  useEffect(() => { fetchTemplates() }, [])
  // User rep visibility — allow-list of boom_reps the user can see on
  // the Approvals + Payments pages. Map keyed by user_id, value = array
  // of allowed rep strings. Fetched once for all users since the table
  // is tiny. For Users, an implicit "own rep" (matching their name) is
  // ALWAYS visible — admins can't remove it; this list grants extras.
  const [visibleReps, setVisibleReps] = useState({}) // { user_id: [rep, ...] }
  const [repBusyKey, setRepBusyKey] = useState(null) // `${user_id}:${rep}` while a mutation is in flight

  useEffect(() => {
    api.get('/settings/users')
      .then(async res => {
        const all = res.data.data || []
        const filtered = currentUserRole === 'Superadmin'
          ? all.filter(u => u.role !== 'Superadmin')
          : all.filter(u => u.role !== 'Admin' && u.role !== 'Superadmin')
        // Fetch permission counts for quickview
        const withCounts = await Promise.all(filtered.map(async u => {
          try {
            const permRes = await api.get(`/settings/permissions/${u.id}`)
            const pages = permRes.data.data
            return { ...u, _permCount: pages === null ? undefined : pages.length }
          } catch { return u }
        }))
        setUsers(withCounts)
      })
      .catch(console.error)
    // Fetch the visible-reps map up front so the selected-user section
    // can render its chips without an extra round-trip.
    api.get('/settings/visible-reps')
      .then(res => setVisibleReps(res.data?.data || {}))
      .catch(() => setVisibleReps({}))
  }, [currentUserRole])

  const addVisibleRep = async (userId, rep) => {
    const key = `${userId}:${rep}`
    setRepBusyKey(key)
    try {
      await api.post('/settings/visible-reps', { user_id: userId, visible_rep: rep })
      setVisibleReps(prev => {
        const list = prev[userId] || []
        if (list.includes(rep)) return prev
        return { ...prev, [userId]: [...list, rep].sort() }
      })
    } catch (err) { console.error(err) }
    finally { setRepBusyKey(null) }
  }
  const removeVisibleRep = async (userId, rep) => {
    const key = `${userId}:${rep}`
    setRepBusyKey(key)
    try {
      await api.delete('/settings/visible-reps', { data: { user_id: userId, visible_rep: rep } })
      setVisibleReps(prev => ({ ...prev, [userId]: (prev[userId] || []).filter(r => r !== rep) }))
    } catch (err) { console.error(err) }
    finally { setRepBusyKey(null) }
  }

  useEffect(() => {
    if (!selectedId) { setAllowed(null); return }
    setLoadingPerms(true)
    setSaved(false)
    api.get(`/settings/permissions/${selectedId}`)
      .then(res => {
        const pages = res.data.data  // null or array
        if (pages === null) {
          setUnrestricted(true)
          setAllowed(new Set(ALL_PAGES.map(p => p.path)))
        } else {
          setUnrestricted(false)
          setAllowed(new Set(pages))
        }
      })
      .catch(console.error)
      .finally(() => setLoadingPerms(false))
  }, [selectedId])

  const toggle = (path) => {
    setSaved(false)
    setUnrestricted(false)
    setAllowed(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const selectAll = () => {
    setSaved(false)
    setUnrestricted(true)
    setAllowed(new Set(ALL_PAGES.map(p => p.path)))
  }

  // Apply a preset or a saved template — ADDS its pages to the current
  // allowed set (lib/navPresets.js addPaths: paths the app no longer has are
  // dropped). Additive by John's call (2026-09-18): a person who does two
  // jobs gets both presets, and "apply" must never silently take away what a
  // previous apply gave. Use Clear first to start over.
  const applyTemplate = (tmpl) => {
    if (!tmpl) return
    setSaved(false)
    setUnrestricted(false)
    setAllowed(prev => addPaths(unrestricted ? new Set() : (prev || new Set()), tmpl.paths))
  }

  // Save the CURRENT selection as a named template. Re-using an existing
  // name updates that template (server upserts case-insensitively).
  const saveAsTemplate = async () => {
    const pages = unrestricted ? ALL_PAGES.map(p => p.path) : [...(allowed || [])]
    if (!pages.length) { alert('Select at least one page first.'); return }
    const name = window.prompt('Template name (re-using an existing name updates it):', '')
    if (!name || !name.trim()) return
    setTemplateBusy(true)
    try {
      const res = await api.post('/settings/permission-templates', { name: name.trim(), pages })
      await fetchTemplates()
      alert(res.data?.updated ? `Updated template "${name.trim()}".` : `Saved template "${name.trim()}" (${pages.length} pages).`)
    } catch (err) {
      alert('Failed to save template: ' + (err.response?.data?.error || err.message))
    } finally { setTemplateBusy(false) }
  }

  const deleteTemplate = async (tmpl) => {
    if (!window.confirm(`Delete the "${tmpl.name}" template? Users who already have its pages keep them.`)) return
    setTemplateBusy(true)
    try {
      await api.delete(`/settings/permission-templates/${tmpl.id}`)
      await fetchTemplates()
    } catch (err) {
      alert('Failed to delete: ' + (err.response?.data?.error || err.message))
    } finally { setTemplateBusy(false) }
  }

  // Copy another user's permissions onto the currently-selected one.
  // If the source is unrestricted (permissions row absent), we treat
  // that as "grant everything".
  const copyFromUser = async (sourceId) => {
    if (!sourceId || String(sourceId) === String(selectedId)) return
    setCopyBusy(true)
    setSaved(false)
    try {
      const res = await api.get(`/settings/permissions/${sourceId}`)
      const pages = res.data.data  // null (unrestricted) or array
      if (pages === null) {
        setUnrestricted(true)
        setAllowed(new Set(ALL_PAGES.map(p => p.path)))
      } else {
        setUnrestricted(false)
        setAllowed(new Set(pages))
      }
    } catch (err) {
      console.error(err)
    } finally { setCopyBusy(false) }
  }

  // Group-level toggles — bulk check/uncheck every page in a group.
  const setGroup = (group, checked) => {
    setSaved(false)
    setUnrestricted(false)
    setAllowed(prev => {
      const next = new Set(prev)
      for (const p of ALL_PAGES) {
        if (p.group !== group) continue
        if (checked) next.add(p.path); else next.delete(p.path)
      }
      return next
    })
  }
  const toggleGroupCollapsed = (group) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      if (next.has(group)) next.delete(group); else next.add(group)
      return next
    })
  }

  const save = async () => {
    setSaving(true)
    setSaved(false)
    try {
      // "Unrestricted" saves the EXPLICIT full page list. It used to send
      // an empty array (= delete all rows = null permissions), but null is
      // default-CLOSED for Users in AuthContext — so "Full access" and
      // "Select all" were locking Users out of everything but the base
      // whitelist.
      const pages = unrestricted ? ALL_PAGES.map(p => p.path) : [...allowed]
      await api.put(`/settings/permissions/${selectedId}`, { pages })
      // Signal any open UserManual tabs (same browser) to refetch live permissions
      try { localStorage.setItem('boom_permissions_updated', String(Date.now())) } catch {}
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      console.error(err)
    } finally {
      setSaving(false)
    }
  }

  const selectedUser = users.find(u => String(u.id) === String(selectedId))

  return (
    <div>
      {/* User selector */}
      <div className="mb-6">
        <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Select User</label>
        <select
          value={selectedId}
          onChange={e => setSelectedId(e.target.value)}
          className="text-sm border border-rule rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-boom-400 bg-card min-w-[220px]"
        >
          <option value="">— choose a user —</option>
          {users.map(u => (
            <option key={u.id} value={u.id}>{u.name} ({u.department})</option>
          ))}
        </select>
        <p className="text-[11px] text-gray-400 mt-1.5">
          {currentUserRole === 'Superadmin'
            ? 'Admin users are included. Superadmin account cannot be restricted.'
            : 'Admin and Superadmin users always have full access and are excluded here.'}
        </p>
      </div>

      {!selectedId && (
        <div>
          <h3 className="text-sm font-semibold text-gray-800 mb-3">Permissions Overview</h3>
          <div className="bg-card border border-rule rounded-lg overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="bg-gray-50 border-b border-rule">
                  <th className="text-left text-[10px] font-bold text-gray-400 uppercase tracking-wider px-4 py-2.5">User</th>
                  <th className="text-left text-[10px] font-bold text-gray-400 uppercase tracking-wider px-4 py-2.5">Role</th>
                  <th className="text-left text-[10px] font-bold text-gray-400 uppercase tracking-wider px-4 py-2.5">Department</th>
                  <th className="text-left text-[10px] font-bold text-gray-400 uppercase tracking-wider px-4 py-2.5">Access</th>
                  <th className="text-right text-[10px] font-bold text-gray-400 uppercase tracking-wider px-4 py-2.5"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {users.map(u => (
                  <tr key={u.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <div className="w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center text-xs font-bold text-gray-500">
                          {u.name?.charAt(0)?.toUpperCase()}
                        </div>
                        <span className="text-sm font-medium text-gray-900">{u.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                        u.role === 'Superadmin' ? 'bg-purple-50 text-purple-700'
                          : u.role === 'Admin' ? 'bg-red-50 text-boom-600'
                          : u.role === 'Approver' ? 'bg-amber-50 text-amber-700'
                          : 'bg-gray-100 text-gray-500'
                      }`}>{u.role}</span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="text-xs text-gray-500">{u.department || '—'}</span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="text-xs text-gray-500">
                        {['Superadmin', 'Admin', 'Approver'].includes(u.role)
                          ? 'Full access'
                          : (u._permCount !== undefined ? u._permCount + ' pages' : 'Unrestricted')}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        onClick={() => setSelectedId(String(u.id))}
                        className="text-xs font-medium text-boom-600 hover:text-boom-700 transition-colors"
                      >
                        Configure
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {selectedId && loadingPerms && (
        <div className="flex items-center justify-center py-16">
          <div className="w-5 h-5 border-2 border-boom-600 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {selectedId && !loadingPerms && allowed !== null && (
        <>
          <div className="flex items-center justify-between mb-3 flex-wrap gap-3">
            <div>
              <p className="text-sm font-semibold text-gray-800">
                Pages for <span className="text-boom-700">{selectedUser?.name}</span>
              </p>
              <p className="text-xs text-gray-400 mt-0.5">
                {unrestricted
                  ? 'Currently unrestricted — can see all pages.'
                  : `${allowed.size} of ${ALL_PAGES.length} pages allowed.`
                }
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {/* Apply template — starter presets. Native <select>
                  used as a menu; value resets to '' after each apply
                  so the same template can be re-applied (via change
                  event) if the user clears manually. */}
              <select
                value=""
                onChange={(e) => {
                  const v = e.target.value
                  if (v.startsWith('custom:')) {
                    const t = customTemplates.find(x => String(x.id) === v.slice(7))
                    if (t) applyTemplate({ key: `custom-${t.id}`, paths: t.pages || [] })
                  } else {
                    const t = PRESETS.find(x => x.key === v)
                    if (t) applyTemplate(t)
                  }
                  e.target.value = ''
                }}
                className="text-xs font-semibold border border-rule rounded-lg px-3 py-1.5 bg-card cursor-pointer"
                title="Add a preset's or a saved template's pages to this user (additive — use Clear to start over)"
              >
                <option value="">Add preset…</option>
                {customTemplates.length > 0 && (
                  <optgroup label="Your templates">
                    {customTemplates.map(t => (
                      <option key={t.id} value={`custom:${t.id}`}>
                        {t.name} ({(t.pages || []).length})
                      </option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="Role presets">
                  {PRESETS.map(t => (
                    <option key={t.key} value={t.key} title={t.description}>{t.label}</option>
                  ))}
                </optgroup>
              </select>
              <button
                onClick={saveAsTemplate}
                disabled={templateBusy}
                className="text-xs font-semibold text-gray-500 hover:text-gray-800 border border-rule px-3 py-1.5 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
                title="Save the currently-checked pages as a reusable named template"
              >
                {templateBusy ? 'Saving…' : 'Save as template'}
              </button>
              {/* Copy from another user — great for onboarding a new
                  hire that should mirror an existing teammate. */}
              <select
                value=""
                disabled={copyBusy}
                onChange={(e) => {
                  const id = e.target.value
                  if (id) copyFromUser(id)
                  e.target.value = ''
                }}
                className="text-xs font-semibold border border-rule rounded-lg px-3 py-1.5 bg-card cursor-pointer disabled:opacity-50"
                title="Overwrite this user's permissions with a copy of another user's"
              >
                <option value="">{copyBusy ? 'Copying…' : 'Copy from user…'}</option>
                {users.filter(u => String(u.id) !== String(selectedId)).map(u => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </select>
              <button
                onClick={selectAll}
                className="text-xs font-semibold text-gray-500 hover:text-gray-800 border border-rule px-3 py-1.5 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Select all
              </button>
            </div>
          </div>

          {/* Custom template manager — chips for the admin-built templates
              with inline delete. Applying happens from the menu above. */}
          {customTemplates.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap mb-4">
              <span className="text-[10px] font-bold uppercase tracking-wide text-gray-400">Your templates:</span>
              {customTemplates.map(t => (
                <span
                  key={t.id}
                  className="inline-flex items-center gap-1.5 bg-card border border-rule rounded-full px-2.5 py-1 text-[11px] font-semibold text-gray-700"
                  title={`${(t.pages || []).length} pages · saved by ${t.created_by || 'unknown'}`}
                >
                  {t.name}
                  <span className="text-gray-400 font-normal">{(t.pages || []).length}</span>
                  <button
                    onClick={() => deleteTemplate(t)}
                    disabled={templateBusy}
                    className="text-gray-300 hover:text-red-500 leading-none"
                    title="Delete this template"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Search — filters the visible pages by label. Groups with
              zero matches disappear entirely; groups with matches
              auto-expand regardless of collapsed state. */}
          <div className="mb-4 relative">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Filter pages…"
              className="w-full pl-8 pr-3 py-2 text-sm border border-rule rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-boom-400"
            />
          </div>

          <div className="space-y-3 mb-6">
            {PAGE_GROUPS.map(group => {
              // Pages in this group, filtered by search. Case-
              // insensitive match on label.
              const q = search.trim().toLowerCase()
              const pagesAll = ALL_PAGES.filter(p => p.group === group)
              const pagesVisible = q
                ? pagesAll.filter(p => p.label.toLowerCase().includes(q))
                : pagesAll
              if (pagesVisible.length === 0) return null

              const groupSelected = pagesAll.filter(p => allowed.has(p.path)).length
              const allInGroup = groupSelected === pagesAll.length
              const noneInGroup = groupSelected === 0
              // While searching, keep every group open so filtered
              // results are visible regardless of the collapse state.
              const isCollapsed = !q && collapsedGroups.has(group)

              return (
                <div key={group} className="border border-rule rounded-lg overflow-hidden">
                  <div className="flex items-center justify-between bg-gray-50 px-3 py-2">
                    <button
                      type="button"
                      onClick={() => toggleGroupCollapsed(group)}
                      disabled={!!q}
                      className="flex items-center gap-2 text-[11px] font-bold text-gray-500 uppercase tracking-widest hover:text-gray-800 disabled:cursor-default"
                      title={q ? 'Collapse disabled while searching' : (isCollapsed ? 'Expand' : 'Collapse')}
                    >
                      {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                      {group}
                      <span className="text-[10px] font-semibold text-gray-400 tracking-normal normal-case">
                        · {groupSelected} of {pagesAll.length}
                      </span>
                    </button>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setGroup(group, true)}
                        disabled={allInGroup}
                        className="text-[10px] font-semibold text-emerald-700 hover:text-emerald-900 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Select all
                      </button>
                      <span className="text-gray-300 text-[10px]">·</span>
                      <button
                        type="button"
                        onClick={() => setGroup(group, false)}
                        disabled={noneInGroup}
                        className="text-[10px] font-semibold text-rose-600 hover:text-rose-800 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                  {!isCollapsed && (
                    <div className="grid grid-cols-2 gap-2 p-2">
                      {pagesVisible.map(page => {
                        const isChecked = allowed.has(page.path)
                        return (
                          <button
                            key={page.path}
                            onClick={() => toggle(page.path)}
                            className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border text-left transition-all ${
                              isChecked
                                ? 'border-boom-300 bg-boom-50'
                                : 'border-rule bg-card hover:border-gray-300'
                            }`}
                          >
                            <div className={`w-4 h-4 rounded flex items-center justify-center flex-shrink-0 transition-colors ${
                              isChecked ? 'bg-boom-600' : 'border border-gray-300 bg-card'
                            }`}>
                              {isChecked && <Check size={10} strokeWidth={3} className="text-white" />}
                            </div>
                            <span className={`text-sm font-medium ${isChecked ? 'text-boom-800' : 'text-gray-600'}`}>
                              {page.label}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
            {/* Nothing-matches state when the search filter clears
                every group. */}
            {search.trim() && PAGE_GROUPS.every(g => {
              const q = search.trim().toLowerCase()
              return ALL_PAGES.filter(p => p.group === g).every(p => !p.label.toLowerCase().includes(q))
            }) && (
              <div className="text-center text-xs text-gray-400 py-6">
                No pages match "{search}".
              </div>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={save}
              disabled={saving}
              className="text-sm font-semibold bg-gray-900 text-white px-5 py-2.5 rounded-xl hover:bg-gray-800 transition-colors disabled:opacity-40 flex items-center gap-2"
            >
              {saving ? <><Loader size={14} className="animate-spin" /> Saving…</> : 'Save Permissions'}
            </button>
            {saved && (
              <div className="flex items-center gap-1.5 text-sm font-semibold text-emerald-600">
                <CheckCircle2 size={15} /> Saved
              </div>
            )}
          </div>

          {/* Rep visibility — controls which boom_rep submissions a non-
              admin user sees on Approvals + Payments. Allow-list model:
              an Approver sees only the reps listed here (empty = nothing);
              a User sees their OWN rep by default plus any reps listed
              here. Admins / Superadmins ignore this list entirely and
              see every rep. */}
          {(selectedUser?.role === 'Approver' || selectedUser?.role === 'User') && (() => {
            const isApprover = selectedUser.role === 'Approver'
            const allows = visibleReps[selectedUser.id] || []
            // Own-rep comes from the admin-assigned boom_rep column on
            // users (Market Street Rep field in this modal). Implicit visibility:
            // entries with the matching boom_rep are always visible to
            // this user, no allow-list entry needed.
            const ownRep = (selectedUser.boom_rep || '').trim()
            const hasOwnRep = !!ownRep && BOOM_REPS.some(r => r.toLowerCase() === ownRep.toLowerCase())
            // Reserve the own-rep from the +Allow dropdown — no point in
            // adding it explicitly since the implicit own-rep already
            // covers it.
            const reserved = hasOwnRep ? [ownRep.toLowerCase()] : []
            const available = BOOM_REPS.filter(r =>
              !allows.includes(r) && !reserved.includes(r.toLowerCase())
            )
            return (
              <div className="mt-8 pt-6 border-t border-rule">
                <div className="flex items-center gap-2 mb-3">
                  <EyeOff size={15} className="text-amber-600" />
                  <p className="text-sm font-semibold text-gray-800">Rep visibility</p>
                </div>
                <p className="text-xs text-gray-500 mb-3">
                  {isApprover ? (
                    <><strong>{selectedUser.name}</strong> will see invoices on Approvals + Payments where the rep is their assigned Market Street Rep or one of the reps listed below. Empty list + no Market Street Rep = sees nothing.</>
                  ) : (
                    <><strong>{selectedUser.name}</strong> will see invoices where the rep matches their assigned Market Street Rep, plus any extra reps listed below. Action endpoints stay admin-only — Users are view-only.</>
                  )}
                </p>
                <div className="flex items-center gap-2 flex-wrap">
                  {/* Implicit own-rep — non-removable. Sourced from the
                      user's admin-assigned boom_rep column. */}
                  {hasOwnRep && (
                    <span
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200"
                      title="Implicit — this user is assigned to this rep, so invoices with this boom_rep are always visible to them. Change the Market Street Rep field in the user edit modal."
                    >
                      {ownRep}
                      <span className="text-[9px] uppercase tracking-wider opacity-70">Own</span>
                    </span>
                  )}
                  {allows.map(rep => {
                    const busy = repBusyKey === `${selectedUser.id}:${rep}`
                    return (
                      <span
                        key={rep}
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-200 ${busy ? 'opacity-50' : ''}`}
                      >
                        {rep}
                        <button
                          onClick={() => removeVisibleRep(selectedUser.id, rep)}
                          disabled={busy}
                          className="hover:text-amber-900 disabled:opacity-50"
                          title={`Stop letting ${selectedUser.name} see ${rep}'s submissions`}
                        >
                          <X size={11} />
                        </button>
                      </span>
                    )
                  })}
                  {available.length > 0 && (
                    <select
                      value=""
                      onChange={e => { if (e.target.value) addVisibleRep(selectedUser.id, e.target.value) }}
                      className="text-xs border border-dashed border-gray-300 rounded-full px-2.5 py-1 bg-card text-gray-500 cursor-pointer hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-boom-300"
                      title="Grant visibility to another rep"
                    >
                      <option value="">+ Allow a rep…</option>
                      {available.map(rep => (
                        <option key={rep} value={rep}>{rep}</option>
                      ))}
                    </select>
                  )}
                  {!hasOwnRep && allows.length === 0 && available.length > 0 && (
                    <span className="text-xs text-amber-700 italic">
                      No Market Street Rep assigned and no reps allowed — this user currently sees nothing on Approvals or Payments.
                    </span>
                  )}
                </div>
              </div>
            )
          })()}
        </>
      )}
    </div>
  )
}

// ─── My Nav Tab ──────────────────────────────────────────────────────────────

function MyNavTab() {
  const { canView } = useAuth()
  const [hiddenPages, setHiddenPages] = useState(() => {
    try { return JSON.parse(localStorage.getItem('nav_hidden_pages') || '[]') } catch { return [] }
  })

  const togglePage = (path) => {
    setHiddenPages(prev => {
      const next = prev.includes(path) ? prev.filter(p => p !== path) : [...prev, path]
      localStorage.setItem('nav_hidden_pages', JSON.stringify(next))
      return next
    })
  }
  const resetAll = () => {
    setHiddenPages([])
    localStorage.setItem('nav_hidden_pages', '[]')
  }

  // Group pages the user can access
  const groups = {}
  ALL_PAGES.forEach(p => {
    if (!canView(p.path)) return
    if (!groups[p.group]) groups[p.group] = []
    groups[p.group].push(p)
  })

  const visibleCount = ALL_PAGES.filter(p => canView(p.path) && !hiddenPages.includes(p.path)).length
  const totalCount = ALL_PAGES.filter(p => canView(p.path)).length

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <p className="text-sm text-gray-500">{visibleCount} of {totalCount} pages shown in your nav.</p>
        </div>
        {hiddenPages.length > 0 && (
          <button onClick={resetAll} className="text-xs font-semibold text-boom-600 hover:text-boom-700 px-3 py-1.5 rounded-lg border border-boom-200 hover:bg-boom-50 transition-colors">
            Show all
          </button>
        )}
      </div>

      <div className="space-y-6">
        {Object.entries(groups).map(([groupName, pages]) => (
          <div key={groupName}>
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2">{groupName}</p>
            <div className="grid grid-cols-2 gap-2">
              {pages.map(page => {
                const checked = !hiddenPages.includes(page.path)
                return (
                  <label
                    key={page.path}
                    className={`flex items-center gap-3 px-4 py-3 rounded-xl border cursor-pointer transition-all ${
                      checked
                        ? 'border-boom-200 bg-boom-50/50 text-boom-800'
                        : 'border-rule bg-card text-gray-400 hover:border-gray-300'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => togglePage(page.path)}
                      style={{ accentColor: '#334155', width: 16, height: 16 }}
                    />
                    <span className={`text-sm font-medium ${checked ? 'text-boom-700' : 'text-gray-400'}`}>{page.label}</span>
                  </label>
                )
              })}
            </div>
          </div>
        ))}
      </div>
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

// ─── Test Users Tab (Superadmin-only) ────────────────────────────────────────
function TestUsersTab() {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [form, setForm] = useState({ id: null, name: '', email: '', password: '', role: 'Admin' })
  const [saving, setSaving] = useState(false)
  const [pendingEmail, setPendingEmail] = useState(null)
  const [teamRoster, setTeamRoster] = useState([])
  useEffect(() => {
    api.get('/team').then(r => {
      const list = Array.isArray(r.data?.data) ? r.data.data : (Array.isArray(r.data) ? r.data : [])
      setTeamRoster(list.filter(u => u && u.email))
    }).catch(() => {})
  }, [])

  const fetchUsers = async () => {
    setLoading(true)
    try {
      const res = await api.get('/settings/test-users')
      setUsers(res.data.data || [])
      setError('')
    } catch (err) { setError('Failed to load test users') }
    finally { setLoading(false) }
  }
  useEffect(() => { fetchUsers() }, [])

  const openNew = () => { setForm({ id: null, name: '', email: '', password: '', role: 'Admin' }); setShowModal(true) }
  const openEdit = (u) => { setForm({ id: u.id, name: u.name, email: u.email, password: '', role: u.role }); setShowModal(true) }

  const save = async () => {
    if (!form.name || !form.email || (!form.id && !form.password)) { setError('Name, email, and password are required'); return }
    setSaving(true)
    try {
      if (form.id) {
        const body = { name: form.name, role: form.role }
        if (form.password) body.password = form.password
        await api.put(`/settings/test-users/${form.id}`, body)
      } else {
        const r = await api.post('/settings/test-users', {
          name: form.name, email: form.email, password: form.password, role: form.role,
        })
        if (r.data?.pending_email) setPendingEmail(r.data.pending_email)
      }
      setShowModal(false)
      await fetchUsers()
      setError('')
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed')
    } finally { setSaving(false) }
  }

  const del = async (id) => {
    if (!window.confirm('Delete this test user? This cannot be undone.')) return
    try {
      await api.delete(`/settings/test-users/${id}`)
      await fetchUsers()
    } catch (err) { setError(err.response?.data?.error || 'Delete failed') }
  }

  return (
    <div>
      <div className="card p-5 mb-4 bg-violet-50 border-violet-200 text-violet-900 text-sm">
        <p className="font-semibold mb-1 flex items-center gap-2"><FlaskConical size={14} /> Demo accounts</p>
        <p className="text-xs leading-relaxed">
          Test users log in like any other account, but they see <strong>mocked sample data only</strong> — no real Market Street information is ever visible to them.
          Use these accounts to demo the app to people outside the company. Only Superadmin can see this tab.
        </p>
      </div>

      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold text-gray-900">{users.length} test user{users.length === 1 ? '' : 's'}</h3>
        <button onClick={openNew} className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-boom-600 text-white hover:bg-boom-700">
          <Plus size={13} /> New Test User
        </button>
      </div>

      {error && <div className="mb-3 text-xs text-red-600 font-semibold">{error}</div>}

      <div className="card overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-gray-500 text-sm"><Loader size={14} className="animate-spin inline mr-2" />Loading…</div>
        ) : users.length === 0 ? (
          <div className="p-8 text-center text-gray-500 text-sm">No test users yet. Click "New Test User" to add one.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase text-gray-400 font-bold tracking-wider">
                <th className="text-left px-4 py-3">Name</th>
                <th className="text-left px-4 py-3">Email</th>
                <th className="text-left px-4 py-3">Simulated Role</th>
                <th className="text-left px-4 py-3">Created</th>
                <th className="w-20"></th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} className="border-t border-divider">
                  <td className="px-4 py-2.5 font-semibold text-gray-900">{u.name}</td>
                  <td className="px-4 py-2.5 text-gray-500 font-mono text-xs">{u.email}</td>
                  <td className="px-4 py-2.5">
                    <span className="inline-block px-2 py-0.5 bg-violet-100 text-violet-800 rounded text-[11px] font-bold">{u.role}</span>
                  </td>
                  <td className="px-4 py-2.5 text-gray-400 text-xs">{new Date(u.created_at).toLocaleDateString()}</td>
                  <td className="px-4 py-2.5 text-right">
                    <button onClick={() => openEdit(u)} title="Edit" className="p-1 text-gray-400 hover:text-gray-700"><Pencil size={13} /></button>
                    <button onClick={() => del(u.id)} title="Delete" className="p-1 text-gray-400 hover:text-red-600"><Trash2 size={13} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-overlay flex items-center justify-center z-50" onClick={() => !saving && setShowModal(false)}>
          <div className="bg-card rounded-2xl shadow-xl p-6 w-[440px]" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-bold text-gray-900 mb-1">{form.id ? 'Edit test user' : 'New test user'}</h3>
            <p className="text-xs text-gray-500 mb-4">They'll be able to log in and navigate the app — all data they see is mocked.</p>
            <div className="space-y-3">
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">Name</label>
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  className="w-full border-2 border-rule rounded-lg px-3 py-2 text-sm outline-none focus:border-boom-500" />
              </div>
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">Email</label>
                <input type="email" value={form.email} disabled={!!form.id}
                  onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  className="w-full border-2 border-rule rounded-lg px-3 py-2 text-sm outline-none focus:border-boom-500 disabled:bg-gray-50 disabled:text-gray-400" />
                {form.id && <p className="text-[10px] text-gray-400 mt-1">Email is read-only after creation.</p>}
              </div>
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">
                  Password {form.id && <span className="normal-case font-normal text-gray-400">— leave blank to keep current</span>}
                </label>
                <input type="text" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                  placeholder={form.id ? 'New password (optional)' : 'Password'}
                  className="w-full border-2 border-rule rounded-lg px-3 py-2 text-sm outline-none focus:border-boom-500" />
              </div>
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">Simulated Role</label>
                <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
                  className="w-full border-2 border-rule rounded-lg px-3 py-2 text-sm outline-none focus:border-boom-500 bg-card">
                  <option value="Admin">Admin (sees every page)</option>
                  <option value="User">User (standard permissions)</option>
                </select>
              </div>
            </div>
            <div className="flex gap-2 justify-end mt-5">
              <button onClick={() => setShowModal(false)} disabled={saving}
                className="px-4 py-2 text-sm font-semibold rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200">Cancel</button>
              <button onClick={save} disabled={saving}
                className="px-4 py-2 text-sm font-semibold rounded-lg bg-boom-600 text-white hover:bg-boom-700 disabled:opacity-50">
                {saving ? 'Saving…' : (form.id ? 'Save changes' : 'Create')}
              </button>
            </div>
          </div>
        </div>
      )}
      {pendingEmail && (
        <EmailPreviewModal
          open
          title="Send demo-account invitation"
          subtitle={`New test user: ${pendingEmail.context?.name || pendingEmail.to}`}
          previewKind={pendingEmail.kind}
          previewContext={pendingEmail.context}
          initialTo={pendingEmail.to}
          initialCc={pendingEmail.cc}
          initialSubject={pendingEmail.subject}
          initialHtml={pendingEmail.html}
          team={teamRoster}
          onClose={() => setPendingEmail(null)}
          onSent={() => setPendingEmail(null)}
          onSkipped={() => setPendingEmail(null)}
          skipLabel="Skip invitation"
        />
      )}
    </div>
  )
}

// ─── Archive Tab (Superadmin-only) ───────────────────────────────────────────
// One-shot, comprehensive export of every business-relevant table and file
// attachment in the system. Intended for end-of-tenure handoffs — the
// resulting ZIP is meant to stand on its own without access to the app.
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

export default function Settings() {
  const { user } = useAuth()
  const currentUserRole = user?.role
  const isAdmin = currentUserRole === 'Admin' || currentUserRole === 'Superadmin'
  const [tab, setTab] = useState(isAdmin ? 'users' : 'mynav')

  const tabs = [
    ...(isAdmin ? [
      { id: 'users',       label: 'Users',       icon: Users  },
      { id: 'permissions', label: 'Permissions',  icon: Shield },
    ] : []),
    ...(currentUserRole === 'Superadmin' ? [
      { id: 'testusers', label: 'Test Users', icon: FlaskConical },
      { id: 'archive',   label: 'Archive',    icon: FolderArchive },
    ] : []),
    { id: 'mynav', label: 'My Nav', icon: SlidersHorizontal },
    { id: 'theme', label: 'Theme', icon: Sun },
  ]

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle={isAdmin ? 'Manage users, permissions, and preferences.' : 'Customize your experience.'}
      />

      {/* Tabs */}
      <div className="flex gap-1 mb-7 border-b border-rule">
        {tabs.map(t => {
          const Icon = t.icon
          const active = tab === t.id
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 -mb-px transition-colors ${
                active
                  ? 'border-boom-600 text-boom-700'
                  : 'border-transparent text-gray-500 hover:text-gray-800'
              }`}
            >
              <Icon size={15} strokeWidth={active ? 2 : 1.5} />
              {t.label}
            </button>
          )
        })}
      </div>

      {tab === 'users'       && <UsersTab currentUserRole={currentUserRole} currentUserId={user?.id} />}
      {tab === 'permissions' && <PermissionsTab currentUserRole={currentUserRole} />}
      {tab === 'testusers'   && <TestUsersTab />}
      {tab === 'archive'     && <ArchiveTab />}
      {tab === 'mynav'       && <MyNavTab />}
      {tab === 'theme'       && <ThemeTab />}
    </div>
  )
}

