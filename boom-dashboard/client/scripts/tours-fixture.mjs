#!/usr/bin/env node
// Do the tours still point at real things?
//
// Every tour names a page (`path`) and every step a CSS selector (`target`).
// This asserts: the page is in NAV_PAGES (or '/'); the selector's data
// attribute appears in client/src (so some page renders it); ids are unique;
// versions are dates; every step has a title and a body; the welcome tour
// exists. A page change that renames or drops an anchor turns this red, which
// is the rule: the tour changes in the same commit as the page.
//
//     node scripts/tours-fixture.mjs
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const SRC = fileURLToPath(new URL('../src', import.meta.url))
let failed = 0
const ok = (cond, msg) => { console.log(`${cond ? '  ok  ' : '  FAIL'} ${msg}`); if (!cond) failed += 1 }

// navConfig without React (same shim nav-fixture uses)
const rawNav = fs.readFileSync(SRC + '/navConfig.jsx', 'utf8')
const shimNav = rawNav.replace(/import\s*\{[\s\S]*?\}\s*from\s*'lucide-react'/, (m) => {
  const names = m.replace(/import\s*\{|\}\s*from\s*'lucide-react'/g, '').split(',').map((x) => x.trim()).filter(Boolean)
  return names.map((n) => `const ${n} = () => null`).join('\n')
})
const navUrl = 'data:text/javascript;base64,' + Buffer.from(shimNav).toString('base64')
const { NAV_PAGES, NAV_GROUPS } = await import(navUrl)
// tours/index.js imports the nav (for the welcome walk); point it at the shim
const rawTours = fs.readFileSync(SRC + '/tours/index.js', 'utf8').replace("from '../navConfig'", `from '${navUrl}'`)
const { TOURS, tourForPath, WALK_PATHS } = await import('data:text/javascript;base64,' + Buffer.from(rawTours).toString('base64'))

// every data attribute rendered anywhere in the client source
const files = []
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (/\.(jsx|js)$/.test(e.name)) files.push(f) } }
walk(SRC)
const source = files.filter((f) => !f.includes('/tours/')).map((f) => fs.readFileSync(f, 'utf8')).join('\n')
const hasAttr = (attr, value) => value
  ? new RegExp(`${attr}=(?:"${value}"|\\{[^}]*'${value}'[^}]*\\}|\\{\`[^\`]*${value}[^\`]*\`\\})`).test(source) || new RegExp(`tour="${value}"`).test(source) && attr === 'data-tour'
  : new RegExp(`${attr}(?=[\\s>=])`).test(source)

console.log('1. shape')
ok(TOURS.length >= 5, `${TOURS.length} tours`)
ok(new Set(TOURS.map((t) => t.id)).size === TOURS.length, 'ids are unique')
ok(TOURS.some((t) => t.id === 'welcome'), 'a welcome tour exists')
for (const t of TOURS) {
  ok(/^\d{4}-\d{2}-\d{2}$/.test(t.version), `${t.id}: version is a date (${t.version})`)
  ok(t.steps.length >= 1 && t.steps.every((s) => s.title && s.body && (s.target || s.target === null)), `${t.id}: every step has title, body and a target (null = centered card)`)
  ok(t.path === '/' || NAV_PAGES.some((p) => p.path === t.path), `${t.id}: page ${t.path} is in the nav`)
  for (const st of t.steps) if (st.path) ok(st.path === '/' || NAV_PAGES.some((p) => p.path === st.path), `${t.id}: step page ${st.path} is in the nav`)
}

console.log('\n2. every target is rendered by some page')
for (const t of TOURS) for (const s of t.steps) {
  if (s.prepare) ok(['sidebar'].includes(s.prepare), `${t.id}: step prepare '${s.prepare}' is something Layout knows how to do`)
  if (s.roles) ok(Array.isArray(s.roles) && s.roles.every((r) => ['Superadmin', 'Admin', 'Approver', 'Bookkeeper', 'User'].includes(r)), `${t.id}: step roles are real roles`)
  if (s.needs) ok(NAV_PAGES.some((p) => p.path === s.needs), `${t.id}: step needs ${s.needs}, which is in the nav`)
  if (s.target === null) continue
  // a comma-separated list of fallbacks; each must be a data-attribute selector some page renders
  for (const sel of s.target.split(',').map((x) => x.trim())) {
    const m = sel.match(/^\[(data-[a-z0-9-]+)(?:="([^"]+)")?\]/)
    ok(!!m, `${t.id}: target ${sel} is a data-attribute selector`)
    if (m) ok(hasAttr(m[1], m[2]), `${t.id}: ${sel} appears in client/src`)
  }
}

console.log('\n2b. the welcome tour walks the whole nav')
const welcome = TOURS.find((t) => t.id === 'welcome')
const pages = [...new Set(welcome.steps.map((s) => s.path))]
ok(welcome.multipage === true, 'welcome is multipage')
ok(welcome.steps[0].path === '/' && welcome.steps[welcome.steps.length - 1].path === '/', 'it starts and ends on Home')
// every visible nav page has its own tour, and the walk stops there once
const missing = WALK_PATHS.filter((p) => !TOURS.some((t) => t.path === p && !t.match && t.id !== 'welcome'))
ok(missing.length === 0, missing.length ? `every visible page has a tour — MISSING: ${missing.join(', ')}` : `every one of the ${WALK_PATHS.length} visible pages has a tour`)
for (const p of WALK_PATHS) ok(pages.includes(p), `the walk visits ${p}`)
const perPage = welcome.steps.filter((s) => s.page && !/family-tabs/.test(s.target)).reduce((m, s) => { m[s.path] = (m[s.path] || 0) + 1; return m }, {})
ok(Object.values(perPage).every((n) => n === 1), 'one orientation step per page (the deeper steps stay in the page tour)')
// every family gets a tab-strip step, on its first tab's page, before its tabs
for (const g of NAV_GROUPS) for (const item of g.items) if (item.tabbed || item.collapsible) {
  const kids = item.children.filter((c) => !c.hidden && !c.external); if (!kids.length) continue
  const fs_ = welcome.steps.find((s) => s.target === `[data-tour="family-tabs"][data-family="${item.key}"]`)
  ok(!!fs_ && fs_.path === kids[0].path && fs_.family === item.key, `family ${item.label}: a tab-strip step on ${kids[0].path}`)
  ok(kids.every((c) => welcome.steps.some((s) => s.path === c.path && s.family === item.key)), `family ${item.label}: every tab carries the family key`)
}
// hidden pages have tours but are not in the walk
const externals = new Set(NAV_GROUPS.flatMap((g) => g.items.flatMap((i) => (i.children || [i]).filter((c) => c.external).map((c) => c.path))))
const hidden = NAV_PAGES.filter((p) => p.hidden && !externals.has(p.path)).map((p) => p.path)
for (const p of hidden) { ok(TOURS.some((t) => t.path === p && !t.match), `hidden page ${p} has its own tour`); ok(!pages.includes(p), `…and the walk does not visit ${p}`) }

console.log('\n3. routing')
ok(tourForPath('/artists/12')?.id === 'artist-profile', '/artists/12 → the profile tour, not the roster tour')
ok(tourForPath('/artists')?.id === 'artists', '/artists → the roster tour')
ok(tourForPath('/nowhere') === null, 'an unknown path has no tour')
ok(tourForPath('/') ?.id === 'home', '/ → the Home tour (welcome is never a page tour)')

console.log(failed ? `\n${failed} FAILED` : '\nall assertions passed')
process.exit(failed ? 1 : 0)
