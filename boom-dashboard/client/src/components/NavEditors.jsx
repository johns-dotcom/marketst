// The three sidebar editors share one grid (2026-09-22):
//   <NavGrid>            pages grouped like the sidebar, a "shown" toggle per page,
//                        optionally a "granted" toggle too
//   <SidebarEditor>      another person's sidebar (Superadmin/Admin on /team/:id):
//                        which of THEIR granted pages the rail draws
//   <DepartmentNavsTab>  a department's nav — the page list the group gets, plus
//                        which of those stay off the sidebar; Apply rewrites members
// My Nav (Settings) uses NavGrid for the person's own rail.
import { useEffect, useMemo, useState } from 'react'
import { Check, Users, RotateCcw } from 'lucide-react'
import api from '../api'
import { NAV_PAGES, NAV_GROUPS } from '../navConfig'
import { presetsForDepartment, unionPaths } from '../lib/navPresets'
import useOrg, { departmentNames } from '../hooks/useOrg'
import { canViewPath } from '../lib/pageAccess'

const familyOf = {}
for (const g of NAV_GROUPS) for (const i of g.items) if (i.tabbed) for (const c of i.children) familyOf[c.path] = i.label
export const labelFor = (p) => (familyOf[p.path] ? `${familyOf[p.path]} › ${p.label}` : p.label)

// pages: NAV_PAGES rows to list. granted: Set|null (null = "granted" column off).
// hidden: Set of paths kept off the rail. onGrant/onShow toggle one path.
export function NavGrid({ pages, granted, hidden, onGrant, onShow, readOnly = false, testId = 'nav-grid' }) {
  const groups = useMemo(() => { const g = {}; for (const p of pages) (g[p.group] = g[p.group] || []).push(p); return g }, [pages])
  return (
    <div className="space-y-5" data-nav-grid={testId}>
      {Object.entries(groups).map(([groupName, rows]) => (
        <div key={groupName}>
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">{groupName}</p>
          <div className="grid sm:grid-cols-2 gap-x-6 gap-y-0.5">
            {rows.map((p) => {
              const isGranted = granted ? granted.has(p.path) : true
              const isShown = isGranted && !p.hidden && !hidden.has(p.path)
              return (
                <div key={p.path} className={`flex items-center gap-3 text-xs py-1 ${isGranted ? 'text-gray-800' : 'text-gray-400'}`} data-nav-page={p.path} data-granted={isGranted ? '1' : '0'} data-shown={isShown ? '1' : '0'}>
                  {granted && (
                    <label className="inline-flex items-center gap-1.5 w-24 flex-shrink-0" title="In this group's nav — members are granted the page">
                      <input type="checkbox" checked={isGranted} disabled={readOnly} onChange={() => onGrant?.(p.path)} style={{ accentColor: '#334155', width: 13, height: 13 }} data-nav-grant />
                      <span className="text-[10px] uppercase tracking-wider text-gray-400">in nav</span>
                    </label>
                  )}
                  <label className={`inline-flex items-center gap-1.5 flex-1 min-w-0 ${!isGranted || p.hidden ? 'opacity-50' : ''}`} title={p.hidden ? 'Reached from another page, never drawn on the sidebar' : isShown ? 'Shown on the sidebar' : 'Granted, but kept off the sidebar'}>
                    <input type="checkbox" checked={isShown} disabled={readOnly || !isGranted || p.hidden} onChange={() => onShow?.(p.path)} style={{ accentColor: '#059669', width: 13, height: 13 }} data-nav-show />
                    <span className="truncate">{labelFor(p)}{p.hidden && <span className="text-[9px] text-gray-300 ml-1">not on the rail</span>}</span>
                  </label>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

// Another person's sidebar. Reads /settings/users/:id/nav (their granted pages,
// their hidden set, their department's nav) and writes PUT …/nav.
export function SidebarEditor({ person, currentUserRole, onSaved }) {
  const [data, setData] = useState(null)
  const [hidden, setHidden] = useState(new Set())
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState('')
  const canEdit = currentUserRole === 'Superadmin' || (person.role !== 'Admin' && person.role !== 'Superadmin')
  useEffect(() => {
    setData(null); setDirty(false); setNote('')
    api.get(`/settings/users/${person.id}/nav`).then((r) => { const d = r.data?.data || {}; const safe = { hidden: Array.isArray(d.hidden) ? d.hidden : null, pages: Array.isArray(d.pages) ? d.pages : [], department: d.department || person.department, department_nav: d.department_nav || null }; setData(safe); setHidden(new Set(safe.hidden || [])) }).catch(() => setData({ hidden: null, pages: [], department: person.department, department_nav: null }))
  }, [person.id])
  if (!data) return <p className="text-xs text-gray-400 py-2">Loading sidebar…</p>
  const ctx = { role: person.role, pagePermissions: data.pages.length ? data.pages : null }
  const drawn = NAV_PAGES.filter((p) => !p.hidden && canViewPath(p.path, ctx))
  const shownCount = drawn.filter((p) => !hidden.has(p.path)).length
  const toggle = (path) => { setHidden((h) => { const n = new Set(h); n.has(path) ? n.delete(path) : n.add(path); return n }); setDirty(true) }
  const save = async (value) => {
    setSaving(true); setNote('')
    try { const r = await api.put(`/settings/users/${person.id}/nav`, { hidden: value === undefined ? Array.from(hidden) : value }); setHidden(new Set(r.data.data.hidden || [])); setData((d) => ({ ...d, hidden: r.data.data.hidden })); setDirty(false); setNote('Saved'); onSaved?.(r.data.data.hidden) }
    catch (e) { setNote(e?.response?.data?.error || 'Could not save') } finally { setSaving(false); setTimeout(() => setNote(''), 2500) }
  }
  const useDepartment = () => { if (!data.department_nav) return; setHidden(new Set(data.department_nav.hidden || [])); setDirty(true) }
  return (
    <div className="mt-6 border-t border-divider pt-4" data-sidebar-editor data-customised={data.hidden ? '1' : '0'}>
      <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
        <div>
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Their sidebar</p>
          <p className="text-[11px] text-gray-500">{shownCount} of {drawn.length} granted pages drawn on {person.name?.split(' ')[0] || 'their'}'s rail{data.hidden ? '' : ' · using the default (nothing hidden)'}.</p>
        </div>
        {canEdit && (
          <div className="flex items-center gap-2">
            {data.department_nav && <button type="button" onClick={useDepartment} className="text-[11px] text-gray-500 hover:text-gray-900 inline-flex items-center gap-1" title={`Take the ${data.department} nav's sidebar`} data-sidebar-use-department><Users size={11} /> Use the {data.department} nav</button>}
            {data.hidden && <button type="button" onClick={() => save(null)} className="text-[11px] text-gray-500 hover:text-gray-900 inline-flex items-center gap-1" data-sidebar-clear><RotateCcw size={11} /> Show all</button>}
            {dirty && <button type="button" onClick={() => save()} disabled={saving} className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-40" data-sidebar-save>{saving ? 'Saving…' : 'Save sidebar'}</button>}
            {note && <span className="text-[11px] text-emerald-600 inline-flex items-center gap-1"><Check size={11} /> {note}</span>}
          </div>
        )}
      </div>
      {drawn.length === 0 ? <p className="text-xs text-gray-400">Grant pages above first — the sidebar draws only what they can open.</p>
        : <NavGrid pages={drawn} granted={null} hidden={hidden} onShow={toggle} readOnly={!canEdit} testId="sidebar" />}
    </div>
  )
}

// Settings › Navs (Superadmin). One department at a time.
export function DepartmentNavsTab() {
  const [state, setState] = useState(null)     // { navs: [], members: {dept: [...]}}
  const org = useOrg()
  const DEPARTMENTS = departmentNames(org)
  const [dept, setDept] = useState(DEPARTMENTS[0])
  const [pages, setPages] = useState(new Set())
  const [hidden, setHidden] = useState(new Set())
  const [dirty, setDirty] = useState(false)
  const [apply, setApply] = useState(true)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState('')
  const load = () => api.get('/settings/department-navs').then((r) => setState(r.data.data)).catch(() => setState({ navs: [], members: {} }))
  useEffect(() => { load() }, [])
  const row = state?.navs.find((n) => n.department === dept) || null
  // Start from the saved row, else the department's code preset.
  useEffect(() => {
    if (!state) return
    const saved = state.navs.find((n) => n.department === dept)
    if (saved) { setPages(new Set(saved.pages || [])); setHidden(new Set(saved.hidden || [])) }
    else { setPages(new Set(unionPaths(presetsForDepartment(dept, org.departments), org.presets))); setHidden(new Set()) }
    setDirty(false)
  }, [dept, state])
  useEffect(() => { setNote('') }, [dept])   // a note describes the last save of THIS department
  const members = state?.members?.[dept] || []
  const grant = (path) => { setPages((s) => { const n = new Set(s); if (n.has(path)) { n.delete(path); setHidden((h) => { const hh = new Set(h); hh.delete(path); return hh }) } else n.add(path); return n }); setDirty(true) }
  const show = (path) => { setHidden((h) => { const n = new Set(h); n.has(path) ? n.delete(path) : n.add(path); return n }); setDirty(true) }
  const save = async (mode) => {
    setSaving(true); setNote('')
    try {
      const r = await api.put(`/settings/department-navs/${encodeURIComponent(dept)}`, { pages: Array.from(pages), hidden: Array.from(hidden), apply: mode === 'force' ? 'force' : apply })
      const bits = [`Saved ${dept}`]
      if (apply || mode === 'force') bits.push(`applied to ${r.data.applied} member${r.data.applied === 1 ? '' : 's'}`, ...(r.data.customised_kept ? [`${r.data.customised_kept} kept their own sidebar`] : []), ...(r.data.admins_untouched ? [`${r.data.admins_untouched} admin${r.data.admins_untouched === 1 ? '' : 's'} untouched`] : []))
      setNote(bits.join(' · ')); setDirty(false); await load()
    } catch (e) { setNote(e?.response?.data?.error || 'Could not save') } finally { setSaving(false) }
  }
  const resetToPreset = () => { setPages(new Set(unionPaths(presetsForDepartment(dept, org.departments), org.presets))); setHidden(new Set()); setDirty(true) }
  if (!state) return <p className="text-sm text-gray-400">Loading…</p>
  const shownCount = NAV_PAGES.filter((p) => pages.has(p.path) && !p.hidden && !hidden.has(p.path)).length
  return (
    <div data-department-navs>
      <div className="flex items-center gap-2 flex-wrap mb-4">
        {DEPARTMENTS.map((d) => <button key={d} type="button" onClick={() => setDept(d)} data-dept={d} data-saved={state.navs.some((n) => n.department === d) ? '1' : '0'} className={`px-2.5 py-1 rounded-lg text-xs font-medium ${dept === d ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>{d}{state.navs.some((n) => n.department === d) ? '' : ' ·'}</button>)}
        <span className="text-[11px] text-gray-400 ml-1">· = not saved yet (shows the code preset)</span>
      </div>
      <div className="card p-4 mb-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <p className="text-sm font-semibold text-gray-900">{dept}: {pages.size} page{pages.size === 1 ? '' : 's'} granted · {shownCount} on the sidebar</p>
            <p className="text-[11px] text-gray-500 mt-0.5">This nav IS the page list for {dept}. <b>In nav</b> grants the page; the green tick keeps it on the sidebar. {row ? `Saved ${row.updated_at ? new Date(row.updated_at).toLocaleDateString() : ''}${row.updated_by_name ? ` by ${row.updated_by_name}` : ''}.` : 'Not saved yet — this is the code preset; new members get the preset until you save.'}</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button type="button" onClick={resetToPreset} className="text-[11px] text-gray-500 hover:text-gray-900 inline-flex items-center gap-1" data-navs-reset><RotateCcw size={11} /> Start from the preset</button>
            <label className="text-[11px] text-gray-600 inline-flex items-center gap-1.5"><input type="checkbox" checked={apply} onChange={(e) => setApply(e.target.checked)} data-navs-apply /> Apply to {members.filter((m) => !['Admin', 'Superadmin'].includes(m.role)).length} member{members.filter((m) => !['Admin', 'Superadmin'].includes(m.role)).length === 1 ? '' : 's'} now</label>
            <button type="button" onClick={() => save()} disabled={saving || !dirty} className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-40" data-navs-save>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
        {note && <p className="text-xs text-emerald-700 mt-2" data-navs-note>{note}</p>}
        <div className="mt-3 flex items-center gap-2 flex-wrap text-[11px]" data-navs-members>
          <Users size={12} className="text-gray-400" />
          {members.length === 0 ? <span className="text-gray-400">Nobody is in {dept} yet.</span> : members.map((m) => (
            <span key={m.id} className={`px-2 py-0.5 rounded-full border ${['Admin', 'Superadmin'].includes(m.role) ? 'border-gray-200 text-gray-400' : m.customised ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-rule text-gray-600'}`} title={['Admin', 'Superadmin'].includes(m.role) ? 'Admins are never rewritten by a group nav' : m.customised ? 'Customised their own sidebar — Apply keeps it (Force overrides)' : 'On the group default'} data-member={m.id} data-member-customised={m.customised ? '1' : '0'}>{m.name}{['Admin', 'Superadmin'].includes(m.role) ? ` · ${m.role}` : m.customised ? ' · own sidebar' : ''}</span>
          ))}
          {members.some((m) => m.customised && !['Admin', 'Superadmin'].includes(m.role)) && <button type="button" onClick={() => save('force')} disabled={saving} className="text-[11px] text-amber-800 hover:underline" data-navs-force>Apply to everyone, overriding customised sidebars</button>}
        </div>
      </div>
      <NavGrid pages={NAV_PAGES} granted={pages} hidden={hidden} onGrant={grant} onShow={show} testId="department" />
    </div>
  )
}
