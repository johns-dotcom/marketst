// Settings › Roles & teams (2026-09-22): roles, presets and departments as
// editable data. Three sections on one tab:
//   Roles        the four BASE roles (text editable; the tier is the code's) and
//                custom roles — a name on a base role, with its own description
//                and starting presets. Superadmin only (roles bind admins).
//   Presets      bundles of pages: label, description, the pages (NavGrid).
//                Admin + Superadmin. Built-ins editable, not removable.
//   Departments  name (rename cascades), default presets, default hierarchy
//                level. Delete moves its people to another department.
import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2, Check, ChevronDown, ChevronRight, Users } from 'lucide-react'
import api from '../api'
import { NAV_PAGES } from '../navConfig'
import useOrg from '../hooks/useOrg'
import { NavGrid } from './NavEditors'

const ROLE_TONE = { Superadmin: 'bg-purple-50 text-purple-700 border-purple-200', Admin: 'bg-blue-50 text-blue-700 border-blue-200', Approver: 'bg-emerald-50 text-emerald-700 border-emerald-200', User: 'bg-gray-100 text-gray-700 border-gray-200' }
const Lines = ({ value, onChange, placeholder, rows = 4, testId }) => (
  <textarea value={value.join('\n')} onChange={(e) => onChange(e.target.value.split('\n'))} rows={rows} placeholder={placeholder} className="input-base w-full text-xs" data-lines={testId} />
)
const Note = ({ text }) => (text ? <p className={`text-xs mt-2 ${/Could not|refused|needs|already|not a/.test(text) ? 'text-rose-600' : 'text-emerald-700'}`} data-org-note>{text}</p> : null)

export default function OrgEditor({ currentUserRole }) {
  const org = useOrg()
  const isSuper = currentUserRole === 'Superadmin'
  const [open, setOpen] = useState('roles')
  const Section = ({ id, title, sub, children, count }) => (
    <div className="card" data-org-section={id}>
      <button type="button" onClick={() => setOpen(open === id ? '' : id)} className="w-full flex items-center gap-2 px-4 py-3 text-left" aria-expanded={open === id} data-org-toggle={id}>
        {open === id ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />}
        <span className="text-sm font-semibold text-gray-900">{title}</span>
        <span className="text-[11px] text-gray-500 tabular-nums">· {count}</span>
        <span className="text-[11px] text-gray-400 ml-auto hidden sm:inline">{sub}</span>
      </button>
      {open === id && <div className="px-4 pb-4 border-t border-divider pt-4">{children}</div>}
    </div>
  )
  return (
    <div className="space-y-4 max-w-4xl" data-org-editor>
      <p className="text-sm text-gray-600">A <b>role</b> is what the API lets a person do — the four base tiers are enforced in code; a role you add here is a name on one of them with its own description and starting pages. A <b>preset</b> is a bundle of pages. A <b>department</b> picks the default presets and hierarchy level when an account is made.</p>
      <Section id="roles" title="Roles" sub={isSuper ? 'Superadmin edits · base tiers stay' : 'read-only for Admins'} count={org.roles.length}><RolesSection org={org} canEdit={isSuper} /></Section>
      <Section id="presets" title="Presets" sub="bundles of pages; departments and roles point at them" count={org.presets.length}><PresetsSection org={org} canEdit /></Section>
      <Section id="departments" title="Departments" sub="default presets and level for new people" count={org.departments.length}><DepartmentsSection org={org} canEdit /></Section>
      <div className="card p-4" data-role-axes>
        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">Four things that are not the same</p>
        <dl className="grid sm:grid-cols-[140px_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">{org.axes.map(([k, v]) => <div key={k} className="contents"><dt className="font-semibold text-gray-900">{k}</dt><dd className="text-gray-600">{v}</dd></div>)}</dl>
      </div>
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

// ── Presets ──
function PresetsSection({ org, canEdit }) {
  const [editing, setEditing] = useState(null)
  const [note, setNote] = useState('')
  const remove = async (p) => {
    if (!window.confirm(`Remove the preset "${p.label}"? Departments and roles that name it drop it; nobody's pages change.`)) return
    try { await api.delete(`/settings/org/presets/${encodeURIComponent(p.key)}`); setNote(`Removed ${p.label}`); org.refresh() } catch (e) { setNote(e?.response?.data?.error || 'Could not remove') }
  }
  return (
    <div>
      <ul className="divide-y divide-divider">
        {org.presets.map((p) => (
          <li key={p.key} className="py-2 flex items-start gap-3" data-preset-row={p.key} data-builtin={p.builtin ? '1' : '0'}>
            <div className="flex-1 min-w-0"><p className="text-sm font-semibold text-gray-900">{p.label} <span className="text-[10px] text-gray-400 font-normal">{p.key}</span></p><p className="text-xs text-gray-500">{p.description}</p><p className="text-[11px] text-gray-400 mt-0.5" data-preset-count>{p.all ? 'Every page' : `${p.paths.length} pages`}{org.departments.some((d) => (d.presets || []).includes(p.key)) ? ` · default for ${org.departments.filter((d) => (d.presets || []).includes(p.key)).map((d) => d.name).join(', ')}` : ''}</p></div>
            {canEdit && <div className="flex items-center gap-3"><button type="button" onClick={() => setEditing(p.key)} className="text-xs text-boom-700 hover:underline" data-preset-edit={p.key}>Edit</button>{!p.builtin && <button type="button" onClick={() => remove(p)} className="text-xs text-gray-400 hover:text-rose-600 inline-flex items-center gap-1" data-preset-delete={p.key}><Trash2 size={11} /> Remove</button>}</div>}
          </li>
        ))}
      </ul>
      {canEdit && !editing && <button type="button" onClick={() => setEditing('new')} className="btn-secondary text-xs mt-3 inline-flex items-center gap-1" data-preset-new><Plus size={12} /> New preset</button>}
      <Note text={note} />
      {editing && <PresetForm org={org} preset={editing === 'new' ? null : org.presets.find((p) => p.key === editing)} onClose={() => setEditing(null)} onSaved={(msg) => { setNote(msg); setEditing(null); org.refresh() }} />}
    </div>
  )
}
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
      <div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="btn-secondary text-xs">Cancel</button><button type="submit" className="btn-primary text-xs" data-preset-save>{preset ? 'Save preset' : 'Create preset'}</button></div>
    </form>
  )
}

// ── Departments ──
function DepartmentsSection({ org, canEdit }) {
  const [editing, setEditing] = useState(null)
  const [note, setNote] = useState('')
  const remove = async (d) => {
    let move = null
    if (d.members > 0) { move = window.prompt(`${d.members} ${d.members === 1 ? 'person is' : 'people are'} in ${d.name}. Move them to which department?`, org.departments.find((x) => x.name !== d.name)?.name || ''); if (!move) return }
    else if (!window.confirm(`Remove the department "${d.name}"?`)) return
    try { await api.delete(`/settings/org/departments/${encodeURIComponent(d.name)}${move ? `?move_to=${encodeURIComponent(move)}` : ''}`); setNote(`Removed ${d.name}`); org.refresh() } catch (e) { setNote(e?.response?.data?.error || 'Could not remove') }
  }
  return (
    <div>
      <ul className="divide-y divide-divider">
        {org.departments.map((d) => (
          <li key={d.name} className="py-2 flex items-start gap-3" data-department-row={d.name}>
            <div className="flex-1 min-w-0"><p className="text-sm font-semibold text-gray-900">{d.name} <span className="text-[10px] text-gray-400 font-normal inline-flex items-center gap-1"><Users size={10} /> {d.members}</span></p>
              <p className="text-[11px] text-gray-500">Default presets: {(d.presets || []).map((k) => org.presets.find((p) => p.key === k)?.label || k).join(', ') || 'none'}{d.default_level ? ` · level ${d.default_level}` : ''}</p></div>
            {canEdit && <div className="flex items-center gap-3"><button type="button" onClick={() => setEditing(d.name)} className="text-xs text-boom-700 hover:underline" data-department-edit={d.name}>Edit</button><button type="button" onClick={() => remove(d)} className="text-xs text-gray-400 hover:text-rose-600 inline-flex items-center gap-1" data-department-delete={d.name}><Trash2 size={11} /> Remove</button></div>}
          </li>
        ))}
      </ul>
      {canEdit && !editing && <button type="button" onClick={() => setEditing('new')} className="btn-secondary text-xs mt-3 inline-flex items-center gap-1" data-department-new><Plus size={12} /> New department</button>}
      <Note text={note} />
      {editing && <DepartmentForm org={org} dept={editing === 'new' ? null : org.departments.find((d) => d.name === editing)} onClose={() => setEditing(null)} onSaved={(msg) => { setNote(msg); setEditing(null); org.refresh() }} />}
    </div>
  )
}
function DepartmentForm({ org, dept, onClose, onSaved }) {
  const [name, setName] = useState(dept?.name || '')
  const [presets, setPresets] = useState(dept?.presets || [])
  const [level, setLevel] = useState(dept?.default_level || '')
  const [err, setErr] = useState('')
  const save = async (e) => {
    e.preventDefault(); setErr('')
    try {
      const body = { name, presets, default_level: level === '' ? null : Number(level) }
      const r = dept ? await api.put(`/settings/org/departments/${encodeURIComponent(dept.name)}`, body) : await api.post('/settings/org/departments', body)
      onSaved(`${dept ? 'Saved' : 'Created'} ${r.data.data.name}${r.data.data.renamed_from ? ` (renamed from ${r.data.data.renamed_from}; people and its nav followed)` : ''}`)
    } catch (e2) { setErr(e2?.response?.data?.error || 'Could not save') }
  }
  return (
    <form onSubmit={save} className="mt-4 border border-boom-200 bg-boom-50/30 rounded-xl p-4 space-y-3" data-department-form={dept ? dept.name : 'new'}>
      <div className="grid sm:grid-cols-[1fr_8rem] gap-3">
        <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Name</span><input value={name} onChange={(e) => setName(e.target.value)} className="input-base w-full mt-1 text-sm" required data-department-name /></label>
        <label className="block"><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Default level</span><input type="number" min="1" max="99" value={level} onChange={(e) => setLevel(e.target.value)} placeholder="99" className="input-base w-full mt-1 text-sm" data-department-level /></label>
      </div>
      <div><span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Default presets for a new person here</span>
        <div className="flex flex-wrap gap-1.5 mt-1">{org.presets.map((p) => <button key={p.key} type="button" onClick={() => setPresets(presets.includes(p.key) ? presets.filter((k) => k !== p.key) : [...presets, p.key])} className={`text-[11px] px-2.5 py-1 rounded-full border ${presets.includes(p.key) ? 'bg-boom-600 text-white border-boom-600' : 'bg-card text-gray-600 border-rule'}`} data-department-preset={p.key}>{p.label}</button>)}</div></div>
      {dept && name !== dept.name && <p className="text-[11px] text-amber-700">Renaming moves everyone in {dept.name} and its department nav to the new name.</p>}
      {err && <p className="text-xs text-rose-600" data-department-error>{err}</p>}
      <div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="btn-secondary text-xs">Cancel</button><button type="submit" className="btn-primary text-xs" data-department-save>{dept ? 'Save department' : 'Create department'}</button></div>
    </form>
  )
}
