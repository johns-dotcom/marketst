// Settings › Roles & teams (2026-09-22): roles, teams and the page bundles a
// team starts people with, as editable data. Flat cards, Cadence's shape (John:
// "this is what cadence's looks like"): How access actually works (folded, the
// roles live inside) · Permissions (one row per member, Configure opens their
// Access tab) · Teams · Department navs (Superadmin, folded). Sections on one tab:
//   Roles        the four BASE roles (text editable; the tier is the code's) and
//                custom roles — a name on a base role, with its own description
//                and starting presets. Superadmin only (roles bind admins).
//   Teams        departments AND their page bundles in ONE list (2026-09-22,
//                John: "departments and presets should be combined"): a row per
//                department with the pages it starts people with, edited on the
//                team itself. A bundle no team claims is an "extra" underneath.
//                Admin + Superadmin. Built-in bundles editable, not removable.
import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2, Check, ChevronDown, ChevronRight, Users, Pencil, ShieldCheck, ArrowUpNarrowWide } from 'lucide-react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import api from '../api'
import { NAV_PAGES } from '../navConfig'
import useOrg from '../hooks/useOrg'
import { NavGrid, labelFor } from './NavEditors'
import { DepartmentNavsTab } from './NavEditors'

const ROLE_TONE = { Superadmin: 'bg-purple-50 text-purple-700 border-purple-200', Admin: 'bg-blue-50 text-blue-700 border-blue-200', Approver: 'bg-emerald-50 text-emerald-700 border-emerald-200', User: 'bg-gray-100 text-gray-700 border-gray-200' }
const Lines = ({ value, onChange, placeholder, rows = 4, testId }) => (
  <textarea value={value.join('\n')} onChange={(e) => onChange(e.target.value.split('\n'))} rows={rows} placeholder={placeholder} className="input-base w-full text-xs" data-lines={testId} />
)
const Note = ({ text }) => (text ? <p className={`text-xs mt-2 ${/Could not|refused|needs|already|not a/.test(text) ? 'text-rose-600' : 'text-emerald-700'}`} data-org-note>{text}</p> : null)

// A folding card. MODULE-LEVEL on purpose: declared inside OrgEditor it would be a
// new component type on every render, so toggling one card remounted every other
// one — Permissions refetched /settings/people, an open form was thrown away, and
// the "Saved" note was wiped by the org.refresh() that follows a save.
function Card({ id, title, sub, icon: Icon, count, children, foldable = true, open, onToggle }) {
  return (
    <div className="card" id={id} data-org-section={id} data-open={open ? '1' : '0'}>
      <button type="button" onClick={() => foldable && onToggle(id)} className={`w-full flex items-start gap-3 px-5 py-4 text-left ${foldable ? '' : 'cursor-default'}`} aria-expanded={open} data-org-toggle={id}>
        {Icon && <Icon size={16} className="text-gray-400 mt-0.5 flex-shrink-0" />}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-900">{title}{count !== undefined && <span className="text-[11px] text-gray-400 font-normal tabular-nums ml-2">· {count}</span>}</p>
          {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
        </div>
        {foldable && (open ? <ChevronDown size={15} className="text-gray-400 mt-0.5" /> : <ChevronRight size={15} className="text-gray-400 mt-0.5" />)}
      </button>
      {open && <div className="px-5 pb-5">{children}</div>}
    </div>
  )
}

export default function OrgEditor({ currentUserRole }) {
  const org = useOrg()
  const location = useLocation()
  const isSuper = currentUserRole === 'Superadmin'
  // Cards are open unless they are reference material (the roles) or a
  // 50-page grid (the navs); every header still toggles.
  const [closed, setClosed] = useState(() => new Set(['roles', 'navs']))
  const toggle = (id) => setClosed((c) => { const n = new Set(c); n.has(id) ? n.delete(id) : n.add(id); return n })
  const open = (id) => !closed.has(id)
  // A link that names a section (Settings' ?tab= aliases, "All roles compared")
  // opens it and scrolls to it — a folded card is not an answer to a deep link.
  useEffect(() => {
    const id = (location.hash || '').replace('#', '')
    if (!id) return
    setClosed((c) => { if (!c.has(id)) return c; const n = new Set(c); n.delete(id); return n })
    const t = setTimeout(() => { try { document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' }) } catch { /* jsdom */ } }, 60)
    return () => clearTimeout(t)
  }, [location.hash])
  return (
    <div className="space-y-4 max-w-4xl" data-org-editor>
      <Card id="roles" open={open('roles')} onToggle={toggle} title="How access actually works" sub={`The ${org.base_roles.length} roles, and the four different things people mean by "permissions".${isSuper ? '' : ' Read-only for Admins.'}`} count={org.roles.length}>
        <dl className="grid sm:grid-cols-[140px_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs mb-5 border border-rule rounded-xl p-4 bg-gray-50/60" data-role-axes>{org.axes.map(([k, v]) => <div key={k} className="contents"><dt className="font-semibold text-gray-900">{k}</dt><dd className="text-gray-600">{v}</dd></div>)}</dl>
        <p className="text-xs text-gray-500 mb-3">A <b>role</b> is what the API lets a person do — the four base tiers are enforced in code; a role added here is a name on one of them with its own description and starting presets.</p>
        <RolesSection org={org} canEdit={isSuper} />
      </Card>
      <Card id="permissions" open onToggle={toggle} title="Permissions" icon={ShieldCheck} sub="Which pages each person can open. Page rows bind Users and Approvers always, an Admin once curated, a Superadmin never. Configure opens their Access tab." foldable={false}>
        <PermissionsSection org={org} />
      </Card>
      <Card id="teams" open={open('teams')} onToggle={toggle} title="Teams" icon={Users} sub="How the label groups its people, and the pages a new person in each one starts with. A team does not grant access on its own — it seeds the page rows, which the Access tab can then adjust." count={org.departments.length}>
        <TeamsSection org={org} canEdit />
      </Card>
      {isSuper && <Card id="navs" open={open('navs')} onToggle={toggle} title="Department navs" sub="What each department sees. The nav IS the group's page list — saving with Apply rewrites every User and Approver in it." count={org.departments.length}><DepartmentNavsTab /></Card>}
    </div>
  )
}

// ── Permissions: one row per member, the People directory's access summary ──
const accessOf = (p) => {
  if (p.role === 'Superadmin') return 'Full access'
  if (p.role === 'Admin') return p.pages?.length ? `${p.pages.length} pages (curated)` : 'Admin default'
  return p.pages?.length ? `${p.pages.length} page${p.pages.length === 1 ? '' : 's'}` : 'No pages yet'
}
function PermissionsSection({ org }) {
  const [people, setPeople] = useState(null)
  const navigate = useNavigate()
  useEffect(() => { api.get('/settings/people').then((r) => setPeople(r.data?.data || [])).catch(() => setPeople([])) }, [])
  if (!people) return <p className="text-xs text-gray-400">Loading…</p>
  const roleName = (p) => org.roles.find((r) => r.key === (p.role_key || p.role))?.label || p.role
  return (
    <div data-permissions>
      <div className="overflow-x-auto -mx-1">
        <table className="w-full text-sm">
          <thead><tr className="text-[10px] font-bold uppercase tracking-wider text-gray-400 text-left"><th className="px-1 py-2">Member</th><th className="px-1 py-2">Role</th><th className="px-1 py-2">Department</th><th className="px-1 py-2">Access</th><th className="px-1 py-2" /></tr></thead>
          <tbody className="divide-y divide-divider">
            {people.map((p) => (
              <tr key={p.id} data-perm-row={p.id}>
                <td className="px-1 py-2.5 font-medium text-gray-900 whitespace-nowrap">{p.name}</td>
                <td className="px-1 py-2.5"><span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded-full border ${ROLE_TONE[p.role] || ROLE_TONE.User}`}>{roleName(p)}</span></td>
                <td className="px-1 py-2.5 text-gray-600 whitespace-nowrap">{p.department || <span className="text-gray-300">—</span>}</td>
                <td className="px-1 py-2.5 text-gray-600 whitespace-nowrap" data-perm-access>{accessOf(p)}</td>
                <td className="px-1 py-2.5 text-right whitespace-nowrap"><Link to={`/team/${p.id}`} className="text-xs font-semibold text-boom-700 hover:underline" data-perm-configure={p.id}>Configure</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {people.length === 0 && <p className="text-xs text-gray-400 py-2">Nobody yet — add people under People.</p>}
      <label className="block mt-4 max-w-xs"><span className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Member</span>
        <select defaultValue="" onChange={(e) => { if (e.target.value) navigate(`/team/${e.target.value}`) }} className="select-base w-full mt-1 text-sm" data-perm-select>
          <option value="">— select member —</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.name} · {roleName(p)}</option>)}
        </select></label>
    </div>
  )
}

// ── Roles ──
function RolesSection({ org, canEdit }) {
  const [editing, setEditing] = useState(null)   // role key or 'new'
  const [note, setNote] = useState('')
  const remove = async (r) => {
    if (!window.confirm(`Remove the role "${r.label}"? ${r.members ? `${r.members} people on it fall back to ${r.base_role}.` : ''}`)) return
    try { await api.delete(`/settings/org/roles/${encodeURIComponent(r.key)}`); setNote(`Removed ${r.label}`); org.refresh() } catch (e) { setNote(e?.response?.data?.error || 'Could not remove') }
  }
  return (
    <div>
      <div className="grid gap-3 md:grid-cols-2">
        {org.roles.map((r) => (
          <div key={r.key} className="border border-rule rounded-xl p-4 space-y-2" data-role-card={r.key} data-builtin={r.builtin ? '1' : '0'}>
            <div className="flex items-start gap-2">
              <span className={`inline-block text-[11px] font-bold px-2 py-0.5 rounded-full border ${ROLE_TONE[r.base_role] || ROLE_TONE.User}`}>{r.label}</span>
              {!r.builtin && <span className="text-[10px] text-gray-400 mt-1">on {r.base_role}</span>}
              <span className="text-[10px] text-gray-400 mt-1 ml-auto tabular-nums" data-role-members>{r.members} {r.members === 1 ? 'person' : 'people'}</span>
            </div>
            <p className="text-sm font-semibold text-gray-900">{r.short}</p>
            {r.who && <p className="text-xs text-gray-500">{r.who}</p>}
            {r.can?.length > 0 && <ul className="text-xs text-gray-700 space-y-0.5 list-disc pl-4">{r.can.map((c) => <li key={c}>{c}</li>)}</ul>}
            {r.cannot?.length > 0 && <ul className="text-xs text-gray-500 space-y-0.5 list-disc pl-4">{r.cannot.map((c) => <li key={c}>{c}</li>)}</ul>}
            {r.pages && <p className="text-[11px] text-gray-500 border-t border-divider pt-2"><span className="font-semibold text-gray-700">Pages:</span> {r.pages}</p>}
            {r.presets?.length > 0 && <p className="text-[11px] text-gray-500">Starting presets: {r.presets.map((k) => org.presets.find((p) => p.key === k)?.label || k).join(', ')}</p>}
            {canEdit && (
              <div className="flex items-center gap-3 pt-1">
                <button type="button" onClick={() => setEditing(r.key)} className="text-xs text-boom-700 hover:underline" data-role-edit={r.key}>Edit</button>
                {!r.builtin && <button type="button" onClick={() => remove(r)} className="text-xs text-gray-400 hover:text-rose-600 inline-flex items-center gap-1" data-role-delete={r.key}><Trash2 size={11} /> Remove</button>}
              </div>
            )}
          </div>
        ))}
      </div>
      {canEdit && !editing && <button type="button" onClick={() => setEditing('new')} className="btn-secondary text-xs mt-3 inline-flex items-center gap-1" data-role-new><Plus size={12} /> New role</button>}
      <Note text={note} />
      {editing && <RoleForm org={org} role={editing === 'new' ? null : org.roles.find((r) => r.key === editing)} onClose={() => setEditing(null)} onSaved={(msg) => { setNote(msg); setEditing(null); org.refresh() }} />}
    </div>
  )
}
function RoleForm({ org, role, onClose, onSaved }) {
  const [f, setF] = useState({ label: role?.label || '', base_role: role?.base_role || 'User', short: role?.short || '', who: role?.who || '', pages: role?.pages || '', can: role?.can || [], cannot: role?.cannot || [], presets: role?.presets || [] })
  const [err, setErr] = useState('')
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }))
  const save = async (e) => {
    e.preventDefault(); setErr('')
    try {
      const body = { ...f, can: f.can.filter((x) => x.trim()), cannot: f.cannot.filter((x) => x.trim()) }
      const r = role ? await api.put(`/settings/org/roles/${encodeURIComponent(role.key)}`, body) : await api.post('/settings/org/roles', body)
      onSaved(`${role ? 'Saved' : 'Created'} ${r.data.data.label}`)
    } catch (e2) { setErr(e2?.response?.data?.error || 'Could not save') }
  }
  return (
    <form onSubmit={save} className="mt-4 border border-boom-200 bg-boom-50/30 rounded-xl p-4 space-y-3" data-role-form={role ? role.key : 'new'}>
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Name</span><input value={f.label} onChange={(e) => set('label', e.target.value)} className="input-base w-full mt-1 text-sm" required data-role-label /></label>
        <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Base tier (what the API enforces)</span>
          <select value={f.base_role} onChange={(e) => set('base_role', e.target.value)} disabled={!!role?.builtin} className="select-base w-full mt-1 text-sm" data-role-base>{org.base_roles.map((b) => <option key={b}>{b}</option>)}</select>
          {role?.builtin && <span className="text-[10px] text-gray-400">A base role's tier is the code's.</span>}</label>
        <label className="block sm:col-span-2"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">One line</span><input value={f.short} onChange={(e) => set('short', e.target.value)} className="input-base w-full mt-1 text-sm" placeholder="What this role is for" data-role-short /></label>
        <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Who</span><input value={f.who} onChange={(e) => set('who', e.target.value)} className="input-base w-full mt-1 text-sm" /></label>
        <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Pages, in a sentence</span><input value={f.pages} onChange={(e) => set('pages', e.target.value)} className="input-base w-full mt-1 text-sm" /></label>
        <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Can (one per line)</span><Lines value={f.can} onChange={(v) => set('can', v)} testId="can" /></label>
        <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Cannot (one per line)</span><Lines value={f.cannot} onChange={(v) => set('cannot', v)} testId="cannot" /></label>
        <div className="sm:col-span-2"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Starting presets when a person is given this role</span>
          <div className="flex flex-wrap gap-1.5 mt-1">{org.presets.map((p) => <button key={p.key} type="button" onClick={() => set('presets', f.presets.includes(p.key) ? f.presets.filter((k) => k !== p.key) : [...f.presets, p.key])} className={`text-[11px] px-2.5 py-1 rounded-full border ${f.presets.includes(p.key) ? 'bg-boom-600 text-white border-boom-600' : 'bg-card text-gray-600 border-rule'}`} data-role-preset={p.key}>{p.label}</button>)}</div></div>
      </div>
      {err && <p className="text-xs text-rose-600" data-role-error>{err}</p>}
      <div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="btn-secondary text-xs">Cancel</button><button type="submit" className="btn-primary text-xs" data-role-save>{role ? 'Save role' : 'Create role'}</button></div>
    </form>
  )
}
// ── Teams: a department and the pages it starts people with, in one place ──
// (2026-09-22, John: "departments and presets should be combined"). The two are
// still two tables — a bundle can be shared by two departments, and somebody who
// does two jobs holds two of them (lib/navPresets.js: ADDITIVE, not exclusive) —
// but the page list is edited on the team that uses it, not in a second list
// beside it. A bundle no team claims is listed underneath as an extra.
const pagesOf = (dept, org) => {
  const ps = (dept.presets || []).map((k) => org.presets.find((p) => p.key === k)).filter(Boolean)
  if (!ps.length) return { none: true, all: false, paths: [], presets: [] }
  if (ps.some((p) => p.all)) return { none: false, all: true, paths: NAV_PAGES.map((p) => p.path), presets: ps }
  const want = new Set(ps.flatMap((p) => p.paths || []))
  return { none: false, all: false, paths: NAV_PAGES.filter((p) => want.has(p.path)).map((p) => p.path), presets: ps }
}
// What makes this team different, not the five pages every team has — naming
// Home · My Work · Messages · Calendar · Flags on all six rows told you nothing.
const pagesLine = (info, common) => {
  if (info.none) return 'no pages yet — pick a starting set'
  if (info.all) return 'Every page, including the ones hidden from the sidebar'
  const own = info.paths.filter((path) => !common.has(path))
  // a family child reads "Contracts › Active", the house convention (My Nav says it the same way)
  const names = (own.length ? own : info.paths).map((path) => NAV_PAGES.find((p) => p.path === path)).filter(Boolean).map(labelFor)
  return `${info.paths.length} page${info.paths.length === 1 ? '' : 's'} — ${names.slice(0, 4).join(', ')}${names.length > 4 ? '…' : ''}`
}

function TeamsSection({ org, canEdit }) {
  const [editing, setEditing] = useState(null)      // department name · 'new' · { name } (a quick-add carrying the typed name)
  const [editingPreset, setEditingPreset] = useState(null)   // an extra bundle's key, or 'new'
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState('')
  const claimed = new Set(org.departments.flatMap((d) => d.presets || []))
  const extras = org.presets.filter((p) => !claimed.has(p.key))
  const sharedWith = (key, mine) => org.departments.filter((d) => d.name !== mine && (d.presets || []).includes(key)).map((d) => d.name)
  const remove = async (d) => {
    let move = null
    if (d.members > 0) { move = window.prompt(`${d.members} ${d.members === 1 ? 'person is' : 'people are'} in ${d.name}. Move them to which team?`, org.departments.find((x) => x.name !== d.name)?.name || ''); if (!move) return }
    else if (!window.confirm(`Remove the team "${d.name}"? Its pages stay as a bundle.`)) return
    try { await api.delete(`/settings/org/departments/${encodeURIComponent(d.name)}${move ? `?move_to=${encodeURIComponent(move)}` : ''}`); setNote(`Removed ${d.name}`); org.refresh() } catch (e) { setNote(e?.response?.data?.error || 'Could not remove') }
  }
  const removePreset = async (p) => {
    if (!window.confirm(`Remove the bundle "${p.label}"? Nobody's pages change.`)) return
    try { await api.delete(`/settings/org/presets/${encodeURIComponent(p.key)}`); setNote(`Removed ${p.label}`); org.refresh() } catch (e) { setNote(e?.response?.data?.error || 'Could not remove') }
  }
  const lowest = Math.min(...org.departments.map((d) => d.default_level || 99))
  const people = (n) => (n === 1 ? '1 person' : `${n} people`)
  // the pages every team already has — left out of each row's summary
  const sets = org.departments.map((d) => pagesOf(d, org)).filter((i) => !i.none)
  const common = new Set(sets.length > 1 ? sets[0].paths.filter((path) => sets.every((s) => s.paths.includes(path))) : [])
  return (
    <div>
      <ul className="divide-y divide-divider">
        {org.departments.map((d) => {
          const info = pagesOf(d, org)
          const shared = info.presets.flatMap((p) => sharedWith(p.key, d.name))
          return (
            <li key={d.name} className="py-3" data-department-row={d.name}>
              <div className="flex items-center gap-3">
                <p className="text-sm font-medium text-gray-900 flex-1 min-w-0 truncate">{d.name}</p>
                {d.default_level ? <span className="text-[10px] text-gray-400 whitespace-nowrap">level {d.default_level}</span> : null}
                <span className="text-xs text-gray-400 tabular-nums whitespace-nowrap" data-department-members>{people(d.members || 0)}</span>
                {d.default_level && d.default_level === lowest && org.departments.length > 1 && <span className="text-[9px] font-bold uppercase tracking-wider text-gray-400 inline-flex items-center gap-1 whitespace-nowrap" title={`Level ${d.default_level} — sorts first in People`} data-department-first><ArrowUpNarrowWide size={10} /> sorts first</span>}
                {canEdit && <div className="flex items-center gap-1"><button type="button" onClick={() => setEditing(d.name)} className="p-1.5 rounded-md text-gray-400 hover:text-gray-900 hover:bg-gray-100" aria-label={`Edit ${d.name}`} title="Edit the team and its pages" data-department-edit={d.name}><Pencil size={13} /></button><button type="button" onClick={() => remove(d)} className="p-1.5 rounded-md text-gray-400 hover:text-rose-600 hover:bg-rose-50" aria-label={`Remove ${d.name}`} title="Remove" data-department-delete={d.name}><Trash2 size={13} /></button></div>}
              </div>
              <p className={`text-xs mt-0.5 ${info.none ? 'text-amber-700' : 'text-gray-500'}`} data-department-pages>{pagesLine(info, common)}</p>
              {shared.length > 0 && <p className="text-[11px] text-gray-400 mt-0.5" data-department-shared>Shares the {info.presets.map((p) => p.label).join(' and ')} bundle with {[...new Set(shared)].join(', ')} — editing the pages changes both.</p>}
            </li>
          )
        })}
      </ul>
      {canEdit && !editing && !editingPreset && (
        <form onSubmit={(e) => { e.preventDefault(); setEditing({ name: draft.trim() }) }} className="mt-3 flex items-center gap-2" data-department-quick>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="New team" className="input-base text-sm flex-1 max-w-xs" data-department-draft />
          <button type="submit" className="btn-secondary text-xs inline-flex items-center gap-1" data-department-new><Plus size={12} /> Add</button>
        </form>
      )}
      <Note text={note} />
      {editing && <TeamForm org={org} dept={typeof editing === 'string' ? org.departments.find((d) => d.name === editing) : null} initialName={typeof editing === 'object' ? editing.name : ''} onClose={() => setEditing(null)} onSaved={(msg) => { setNote(msg); setEditing(null); setDraft(''); org.refresh() }} />}
      {/* A bundle no team claims — the second job, or one built ahead of the team that will use it. */}
      {(extras.length > 0 || editingPreset) && (
        <div className="mt-5 pt-4 border-t border-divider" data-extra-bundles>
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">Extra bundles</p>
          <p className="text-xs text-gray-500 mb-2">Page sets no team starts with. Tick one on a person's Access tab when they do two jobs.</p>
          <ul className="divide-y divide-divider">
            {extras.map((p) => (
              <li key={p.key} className="py-2 flex items-start gap-3" data-preset-row={p.key} data-builtin={p.builtin ? '1' : '0'}>
                <div className="flex-1 min-w-0"><p className="text-sm font-semibold text-gray-900">{p.label} <span className="text-[10px] text-gray-400 font-normal">{p.key}</span></p><p className="text-xs text-gray-500">{p.description}</p><p className="text-[11px] text-gray-400 mt-0.5" data-preset-count>{p.all ? 'Every page' : `${p.paths.length} pages`}</p></div>
                {canEdit && <div className="flex items-center gap-1"><button type="button" onClick={() => setEditingPreset(p.key)} className="p-1.5 rounded-md text-gray-400 hover:text-gray-900 hover:bg-gray-100" aria-label={`Edit ${p.label}`} title="Edit" data-preset-edit={p.key}><Pencil size={13} /></button><button type="button" onClick={() => removePreset(p)} disabled={p.builtin} className="p-1.5 rounded-md text-gray-400 hover:text-rose-600 hover:bg-rose-50 disabled:opacity-30 disabled:hover:bg-transparent" aria-label={`Remove ${p.label}`} title={p.builtin ? 'Built-in bundles stay' : 'Remove'} data-preset-delete={p.key}><Trash2 size={13} /></button></div>}
              </li>
            ))}
          </ul>
          {editingPreset && <PresetForm org={org} preset={editingPreset === 'new' ? null : org.presets.find((p) => p.key === editingPreset)} onClose={() => setEditingPreset(null)} onSaved={(msg) => { setNote(msg); setEditingPreset(null); org.refresh() }} />}
        </div>
      )}
      {canEdit && !editing && !editingPreset && <button type="button" onClick={() => setEditingPreset('new')} className="text-[11px] text-gray-500 hover:text-gray-900 mt-3 inline-flex items-center gap-1" data-preset-new><Plus size={11} /> New bundle on its own</button>}
    </div>
  )
}

// One form for the team AND the pages it starts people with. A team with exactly
// one bundle edits that bundle's pages inline; a team with none can be given its
// own, created in the same save; a team on two bundles keeps the chips and says
// where to edit each.
function TeamForm({ org, dept, initialName = '', onClose, onSaved }) {
  const [name, setName] = useState(dept?.name || initialName)
  const [presets, setPresets] = useState(dept?.presets || [])
  const [level, setLevel] = useState(dept?.default_level || '')
  const bundle = presets.length === 1 ? org.presets.find((p) => p.key === presets[0]) : null
  const [own, setOwn] = useState(false)                                  // no bundle → build one for this team
  const [all, setAll] = useState(!!bundle?.all)
  const [pages, setPages] = useState(new Set(bundle?.paths || []))
  const [err, setErr] = useState('')
  // Switching which bundle the team is on reloads the page editor from it.
  useEffect(() => {
    const b = presets.length === 1 ? org.presets.find((p) => p.key === presets[0]) : null
    setAll(!!b?.all); setPages(new Set(b?.paths || []))
    if (presets.length) setOwn(false)
  }, [presets.join(','), org.presets.length])   // eslint-disable-line react-hooks/exhaustive-deps
  const editingPages = !!bundle || own
  const save = async (e) => {
    e.preventDefault(); setErr('')
    try {
      let keys = presets
      const paths = all ? '*' : Array.from(pages)
      // the team's own page set: save it as a bundle first, then hand the team its key
      if (bundle) { await api.put(`/settings/org/presets/${encodeURIComponent(bundle.key)}`, { label: bundle.label, description: bundle.description, paths }) }
      else if (own) { const r = await api.post('/settings/org/presets', { label: name, description: `The pages ${name} starts with`, paths }); keys = [r.data.data.key] }
      const body = { name, presets: keys, default_level: level === '' ? null : Number(level) }
      const r2 = dept ? await api.put(`/settings/org/departments/${encodeURIComponent(dept.name)}`, body) : await api.post('/settings/org/departments', body)
      onSaved(`${dept ? 'Saved' : 'Created'} ${r2.data.data.name}${r2.data.data.renamed_from ? ` (renamed from ${r2.data.data.renamed_from}; people and its nav followed)` : ''}`)
    } catch (e2) { setErr(e2?.response?.data?.error || 'Could not save') }
  }
  return (
    <form onSubmit={save} className="mt-4 border border-boom-200 bg-boom-50/30 rounded-xl p-4 space-y-3" data-department-form={dept ? dept.name : 'new'}>
      <div className="grid sm:grid-cols-[1fr_8rem] gap-3">
        <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Name</span><input value={name} onChange={(e) => setName(e.target.value)} className="input-base w-full mt-1 text-sm" required data-department-name /></label>
        <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Default level</span><input type="number" min="1" max="99" value={level} onChange={(e) => setLevel(e.target.value)} placeholder="99" className="input-base w-full mt-1 text-sm" data-department-level /></label>
      </div>
      <div><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Starting pages</span>
        <div className="flex flex-wrap gap-1.5 mt-1">{org.presets.map((p) => <button key={p.key} type="button" onClick={() => setPresets(presets.includes(p.key) ? presets.filter((k) => k !== p.key) : [...presets, p.key])} className={`text-[11px] px-2.5 py-1 rounded-full border ${presets.includes(p.key) ? 'bg-boom-600 text-white border-boom-600' : 'bg-card text-gray-600 border-rule'}`} data-department-preset={p.key}>{p.label}</button>)}</div>
        {presets.length === 0 && (
          <label className="text-xs text-gray-600 inline-flex items-center gap-1.5 mt-2"><input type="checkbox" checked={own} onChange={(e) => setOwn(e.target.checked)} data-department-own /> …or give {name || 'this team'} its own page set</label>
        )}
        {presets.length > 1 && <p className="text-[11px] text-gray-500 mt-2">On two bundles — the pages are the union. Edit either one where its own team is, or under Extra bundles.</p>}
      </div>
      {editingPages && (
        <div className="border-t border-divider pt-3" data-team-pages>
          <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1">{bundle ? `Pages in ${bundle.label}` : 'Pages'}</p>
          <label className="text-xs text-gray-600 inline-flex items-center gap-1.5 mb-2"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} data-preset-all /> Every page, including hidden ones (the unrestricted set)</label>
          {!all && <NavGrid pages={NAV_PAGES} granted={pages} hidden={new Set()} onGrant={(p) => setPages((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n })} onShow={() => {}} testId="preset" />}
        </div>
      )}
      {dept && name !== dept.name && <p className="text-[11px] text-amber-700">Renaming moves everyone in {dept.name} and its department nav to the new name.</p>}
      {err && <p className="text-xs text-rose-600" data-department-error>{err}</p>}
      <div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="btn-secondary text-xs">Cancel</button><button type="submit" className="btn-primary text-xs" data-department-save>{dept ? 'Save team' : 'Create team'}</button></div>
    </form>
  )
}

// A bundle on its own — edited from Extra bundles, or from the team that uses it.
function PresetForm({ org, preset, onClose, onSaved }) {
  const [label, setLabel] = useState(preset?.label || '')
  const [description, setDescription] = useState(preset?.description || '')
  const [all, setAll] = useState(!!preset?.all)
  const [pages, setPages] = useState(new Set(preset?.paths || []))
  const [err, setErr] = useState('')
  const save = async (e) => {
    e.preventDefault(); setErr('')
    try {
      const body = { label, description, paths: all ? '*' : Array.from(pages) }
      const r = preset ? await api.put(`/settings/org/presets/${encodeURIComponent(preset.key)}`, body) : await api.post('/settings/org/presets', body)
      onSaved(`${preset ? 'Saved' : 'Created'} ${r.data.data.label}`)
    } catch (e2) { setErr(e2?.response?.data?.error || 'Could not save') }
  }
  return (
    <form onSubmit={save} className="mt-4 border border-boom-200 bg-boom-50/30 rounded-xl p-4 space-y-3" data-preset-form={preset ? preset.key : 'new'}>
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Name</span><input value={label} onChange={(e) => setLabel(e.target.value)} className="input-base w-full mt-1 text-sm" required data-preset-label /></label>
        <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Description</span><input value={description} onChange={(e) => setDescription(e.target.value)} className="input-base w-full mt-1 text-sm" /></label>
      </div>
      <label className="text-xs text-gray-600 inline-flex items-center gap-1.5"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} data-preset-all /> Every page, including hidden ones (the unrestricted set)</label>
      {!all && <NavGrid pages={NAV_PAGES} granted={pages} hidden={new Set()} onGrant={(p) => setPages((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n })} onShow={() => {}} testId="preset" />}
      {err && <p className="text-xs text-rose-600" data-preset-error>{err}</p>}
      <div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="btn-secondary text-xs">Cancel</button><button type="submit" className="btn-primary text-xs" data-preset-save>{preset ? 'Save bundle' : 'Create bundle'}</button></div>
    </form>
  )
}
