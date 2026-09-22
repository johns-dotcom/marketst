// The live roles, presets and departments (Settings › Roles & teams edits them;
// GET /settings/org serves them). One fetch per session, shared by every caller;
// the static seed (lib/navPresets.js, lib/roles.js) is the answer until the
// server replies and the fallback if it never does. `refresh()` after a write.
import { useEffect, useState } from 'react'
import api from '../api'
import { PRESETS, DEPARTMENT_DEFS, normalizePreset, withDepartment } from '../lib/navPresets'
import { ROLES, BASE_ROLES, AXES } from '../lib/roles'

const FALLBACK = { presets: PRESETS, departments: DEPARTMENT_DEFS, roles: ROLES, base_roles: BASE_ROLES, axes: AXES, live: false }
let cache = null
let inFlight = null
const listeners = new Set()
const shape = (d) => ({
  presets: (d.presets || []).map((p) => withDepartment(normalizePreset(p), d.departments || [])),
  departments: d.departments || [],
  roles: (d.roles || []).map((r) => ({ ...r, id: r.key })),
  base_roles: d.base_roles || BASE_ROLES,
  axes: d.axes || AXES,
  live: true,
})
export function loadOrg(force = false) {
  if (cache && !force) return Promise.resolve(cache)
  if (inFlight && !force) return inFlight
  inFlight = api.get('/settings/org').then((r) => { cache = shape(r.data?.data || {}); for (const l of listeners) l(cache); return cache }).catch(() => cache || FALLBACK).finally(() => { inFlight = null })
  return inFlight
}
export default function useOrg() {
  const [org, setOrg] = useState(cache || FALLBACK)
  useEffect(() => {
    listeners.add(setOrg)
    loadOrg().then((o) => setOrg(o))
    return () => { listeners.delete(setOrg) }
  }, [])
  return { ...org, refresh: () => loadOrg(true) }
}
// Derived helpers over the live lists
export const departmentNames = (org) => org.departments.map((d) => d.name)
export const departmentPresets = (org, name) => org.departments.find((d) => d.name === name)?.presets || []
export const departmentLevel = (org, name) => org.departments.find((d) => d.name === name)?.default_level || null
export const roleLabel = (org, user) => { const r = org.roles.find((x) => x.key === (user?.role_key || user?.role)); return r ? r.label : user?.role }
