// The admin pieces behind People (2026-09-19): the person modal (create /
// edit an account, with presets and starting pages), the delete confirm, the
// Market Street reps panel, and AccessEditor — presets + page checkboxes for an
// EXISTING person, saved to /settings/permissions/:id. Extracted verbatim from
// Settings.jsx when Users and the Permissions matrix retired into /team.
import { useState, useEffect } from 'react'
import { Plus, Pencil, Trash2, X, Loader, Check, ChevronRight, ChevronDown, Search, AlertTriangle } from 'lucide-react'
import api from '../api'
import { NAV_PAGES } from '../navConfig'
import { PRESETS, DEPARTMENTS, DEPARTMENT_LEVEL, presetsForDepartment, unionPaths, addPaths } from '../lib/navPresets'
import { useBoomReps, useBoomRepsContext } from '../context/BoomRepsContext'
import { canViewPath } from '../lib/pageAccess'

const ALL_PAGES = NAV_PAGES
const ALL_ROLES = ['Superadmin', 'Admin', 'Approver', 'User']
const ROLES = ['Admin', 'User'] // shown to regular Admins
const PAGE_GROUPS = [...new Set(ALL_PAGES.map(p => p.group))]

// ─── Market Street Reps management panel ─────────────────────────────────────────────
// Curate the list of reps used by every "Market Street Rep" dropdown in the app
// (Approvals filter, Payments filter, Ledger inline edit, user assignment,
// vendor submit form, etc.). Deactivating a rep just hides them from new
// dropdowns — historical entries that reference the name still work.
export function BoomRepsPanel() {
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

export function PersonModal({ user, onClose, onSaved, currentUserRole }) {
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
  // After creating: the one-time invite link to hand over (copied, or emailed once Gmail exists)
  const [invite, setInvite] = useState(null)
  const [copied, setCopied] = useState(false)

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
    // An Executive starts at the top of the task hierarchy unless a level was typed.
    if (DEPARTMENT_LEVEL[d] && Number(form.hierarchy_level) === 99) set('hierarchy_level', DEPARTMENT_LEVEL[d])
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
        if (res.data.invite?.path) {
          // Stay open to show the link — closing here would lose the only copy.
          setInvite({ ...res.data.invite, url: `${window.location.origin}${res.data.invite.path}`, name: form.name, email: form.email })
          setSaving(false)
          return
        }
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

  if (invite) {
    const copy = async () => { try { await navigator.clipboard.writeText(invite.url); setCopied(true); setTimeout(() => setCopied(false), 2500) } catch { /* the field below is selectable */ } }
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
        <div className="bg-card rounded-2xl shadow-2xl border border-divider w-[480px]" data-invite-panel>
          <div className="flex items-center justify-between px-6 py-4 border-b border-divider">
            <h3 className="text-sm font-bold text-gray-900">{invite.name} is added</h3>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100"><X size={16} /></button>
          </div>
          <div className="p-6 space-y-3">
            <p className="text-sm text-gray-700">Send {invite.name.split(' ')[0]} this link. It sets their password and signs them in; it works once and expires {new Date(invite.expires_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}.</p>
            <div className="flex items-center gap-2">
              <input readOnly value={invite.url} onFocus={(e) => e.target.select()} className="input-base flex-1 text-xs font-mono" data-invite-url />
              <button type="button" onClick={copy} className="text-xs font-semibold px-3 py-2 rounded-lg bg-gray-900 text-white hover:bg-gray-800 whitespace-nowrap" data-copy-invite>{copied ? 'Copied' : 'Copy link'}</button>
            </div>
            <p className="text-[11px] text-gray-400">Until Gmail is connected the link is handed over by you. From People you can resend a fresh one at any time; resending voids this one.</p>
            <div className="flex justify-end pt-1"><button onClick={onClose} className="text-sm font-semibold bg-gray-100 text-gray-700 px-4 py-2 rounded-xl hover:bg-gray-200">Done</button></div>
          </div>
        </div>
      </div>
    )
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

export function DeleteConfirm({ user, onClose, onDeleted }) {
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


// ─── AccessEditor — for a person who already exists ─────────────────────────
// Reads the rows, offers the presets ADDITIVELY (a tick adds pages, never
// removes), lets single pages be toggled, and shows what the person can
// actually reach — computed by the same canViewPath the app enforces, so what
// this panel says is what their login gets. Admin/Superadmin rows are shown
// read-only: those roles are not bound by rows here unless configured.
export function AccessEditor({ person, currentUserRole, onSaved }) {
  const [pages, setPages] = useState(null)      // Set | null (null = no rows)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [dirty, setDirty] = useState(false)
  useEffect(() => {
    setLoading(true)
    api.get(`/settings/permissions/${person.id}`)
      .then((r) => { const d = r.data?.data; setPages(d ? new Set(d) : new Set()) })
      .catch(() => setPages(new Set()))
      .finally(() => setLoading(false))
  }, [person.id])
  const canEdit = currentUserRole === 'Superadmin' || (person.role !== 'Admin' && person.role !== 'Superadmin')
  const presetOn = (pr) => pages && pr.paths.every((p) => pages.has(p))
  const addPreset = (pr) => { setPages((prev) => addPaths(prev || new Set(), pr.paths)); setDirty(true) }
  const toggle = (path) => { setPages((prev) => { const n = new Set(prev || []); n.has(path) ? n.delete(path) : n.add(path); return n }); setDirty(true) }
  const save = async () => {
    setSaving(true); setError('')
    try {
      await api.put(`/settings/permissions/${person.id}`, { pages: Array.from(pages || []) })
      setDirty(false); onSaved && onSaved(Array.from(pages || []))
    } catch (err) { setError(err?.response?.data?.error || 'Could not save') }
    finally { setSaving(false) }
  }
  if (loading) return <p className="text-sm text-gray-400 py-4">Loading access…</p>
  const ctx = { role: person.role, pagePermissions: pages && pages.size ? Array.from(pages) : null }
  const reachable = ALL_PAGES.filter((p) => canViewPath(p.path, ctx))
  return (
    <div data-access-editor>
      <div className="flex items-center justify-between gap-3 mb-2">
        <p className="text-[11px] text-gray-500">
          {person.role === 'Superadmin' ? 'A Superadmin reaches every page; rows here do not bind them.'
            : pages && pages.size ? `${pages.size} page${pages.size === 1 ? '' : 's'} granted · reaches ${reachable.length} of ${ALL_PAGES.length}`
            : person.role === 'User' ? 'No pages granted — a User with no rows sees Home and Settings only.'
            : `No rows — ${person.role} defaults apply.`}
        </p>
        {canEdit && dirty && (
          <button onClick={save} disabled={saving} className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-40" data-access-save>
            {saving ? 'Saving…' : 'Save access'}
          </button>
        )}
      </div>
      {canEdit && (
        <div className="flex flex-wrap items-center gap-1.5 mb-3">
          <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mr-1">Add preset</span>
          {PRESETS.map((pr) => (
            <button key={pr.key} type="button" onClick={() => addPreset(pr)} title={pr.description} data-preset={pr.key}
              className={`text-[11px] font-medium px-2.5 py-1 rounded-full border transition-colors ${presetOn(pr) ? 'bg-boom-600 text-white border-boom-600' : 'bg-card text-gray-600 border-rule hover:border-gray-400'}`}>
              {pr.label}{presetOn(pr) ? ' ✓' : ' +'}
            </button>
          ))}
          <button type="button" onClick={() => { setPages(new Set()); setDirty(true) }} className="text-[10px] font-semibold text-gray-400 hover:text-gray-600 ml-2">Clear</button>
        </div>
      )}
      <div className="grid sm:grid-cols-2 gap-x-6 gap-y-3">
        {PAGE_GROUPS.map((group) => (
          <div key={group}>
            <p className="text-[9px] font-bold text-gray-400 uppercase tracking-wider mb-1">{group}</p>
            <div className="space-y-0.5">
              {ALL_PAGES.filter((p) => p.group === group).map((page) => {
                const on = pages?.has(page.path)
                const reach = canViewPath(page.path, ctx)
                return (
                  <label key={page.path} className={`flex items-center gap-2 text-xs py-0.5 ${canEdit ? 'cursor-pointer' : ''} ${reach ? 'text-gray-700' : 'text-gray-400'}`} data-page={page.path} data-reach={reach ? '1' : '0'}>
                    {canEdit
                      ? <input type="checkbox" checked={!!on} onChange={() => toggle(page.path)} style={{ accentColor: '#334155', width: 13, height: 13 }} />
                      : <span className={`w-1.5 h-1.5 rounded-full ${reach ? 'bg-emerald-500' : 'bg-gray-300'}`} />}
                    {page.label}{page.hidden ? <span className="text-[9px] text-gray-300">hidden</span> : null}
                  </label>
                )
              })}
            </div>
          </div>
        ))}
      </div>
      {error && <p className="text-xs text-rose-600 mt-2">{error}</p>}
    </div>
  )
}
