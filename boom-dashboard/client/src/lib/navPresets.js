// Role presets and departments — the STATIC seed, read from lib/org.seed.json.
// Since 2026-09-22 the live lists are DATA (Settings › Roles & teams edits
// them; server lib/org-config.js seeds the tables from this same JSON), read
// through hooks/useOrg.js. This module stays as the offline fallback and the
// thing the fixtures check, and every helper takes the live list as an
// optional argument so a component can pass what the server holds.
//
// ADDITIVE, NOT EXCLUSIVE. John, 2026-09-18: "some people are both marketing
// and a&r". Permissions are stored per user as a list of paths, and a user can
// hold any set, so a preset is a bundle of paths and two presets UNION. There
// is no concept of "the user's role preset" anywhere — only the rows.
//
// Every path must exist in NAV_PAGES; `unionPaths` filters against it so a
// preset can never grant a page the app no longer has. A preset whose paths is
// the string '*' means every page (the ops preset).
import { NAV_PAGES } from '../navConfig'
import seed from './org.seed.json'

const ALL_PATHS = NAV_PAGES.map((p) => p.path)
export const expandPaths = (paths) => (paths === '*' ? ALL_PATHS : Array.isArray(paths) ? paths : [])
export const normalizePreset = (p) => ({ ...p, paths: expandPaths(p.paths), all: p.paths === '*' })

export const DEPARTMENT_DEFS = seed.departments
// `department` = the department this preset is the default for (read by the fixture and the person form's hints).
export const withDepartment = (p, departments = DEPARTMENT_DEFS) => ({ ...p, department: departments.find((d) => (d.presets || []).includes(p.key))?.name || null })
export const PRESETS = seed.presets.map((p) => withDepartment(normalizePreset(p)))
export const DEPARTMENTS = DEPARTMENT_DEFS.map((d) => d.name)
export const DEPARTMENT_LEVEL = Object.fromEntries(DEPARTMENT_DEFS.filter((d) => d.default_level).map((d) => [d.name, d.default_level]))

export function presetsForDepartment(department, departments = DEPARTMENT_DEFS) {
  return departments.find((d) => d.name === department)?.presets || []
}
export function presetByKey(key, presets = PRESETS) {
  return presets.find((p) => p.key === key) || null
}
/** The union of the named presets' paths, deduped, in NAV_PAGES order, filtered to pages that exist. */
export function unionPaths(keys, presets = PRESETS) {
  const want = new Set()
  for (const k of keys) for (const p of presetByKey(k, presets)?.paths || []) want.add(p)
  return ALL_PATHS.filter((p) => want.has(p))
}
/** Add a list of paths to an existing selection — the editor's "apply" is this. */
export function addPaths(current, paths) {
  const known = new Set(ALL_PATHS)
  const next = new Set(current)
  for (const p of paths) if (known.has(p)) next.add(p)
  return next
}
