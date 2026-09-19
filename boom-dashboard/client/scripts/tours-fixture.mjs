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
const { NAV_PAGES } = await import('data:text/javascript;base64,' + Buffer.from(shimNav).toString('base64'))
const { TOURS, tourForPath } = await import(SRC + '/tours/index.js')

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
  ok(t.steps.length >= 1 && t.steps.every((s) => s.title && s.body && s.target), `${t.id}: every step has target, title, body`)
  ok(t.path === '/' || NAV_PAGES.some((p) => p.path === t.path), `${t.id}: page ${t.path} is in the nav`)
}

console.log('\n2. every target is rendered by some page')
const pages = new Set(NAV_PAGES.map((p) => p.path))
for (const t of TOURS) for (const s of t.steps) {
  // [data-x="v"] · [data-x] · [data-x] child
  const m = s.target.match(/^\[(data-[a-z0-9-]+)(?:="([^"]+)")?\]/)
  ok(!!m, `${t.id}: target ${s.target} is a data-attribute selector`)
  if (m) ok(hasAttr(m[1], m[2]), `${t.id}: ${s.target} appears in client/src`)
}

console.log('\n3. routing')
ok(tourForPath('/artists/12')?.id === 'artist-profile', '/artists/12 → the profile tour, not the roster tour')
ok(tourForPath('/artists')?.id === 'artists', '/artists → the roster tour')
ok(tourForPath('/nowhere') === null, 'an unknown path has no tour')
ok(tourForPath('/') ?.id === 'home', '/ → the Home tour (welcome is never a page tour)')
void pages

console.log(failed ? `\n${failed} FAILED` : '\nall assertions passed')
process.exit(failed ? 1 : 0)
