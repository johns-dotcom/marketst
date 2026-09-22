// Role presets, asserted in node.
//
// A preset is a list of paths that Settings grants in one click and seeds onto
// a new account from its department. Three things can go quietly wrong with
// such a list and none of them shows in a browser: a path that no longer
// exists (a silent no-op grant), a page reachable by a preset whose role the
// route then bounces, and a "both jobs" union that is not actually the union.
//
//   node scripts/navpresets-fixture.mjs

import { fileURLToPath } from 'node:url'
import fs from 'fs'
import { canViewPath } from '../src/lib/pageAccess.js'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

// navConfig imports lucide-react; stub the icons through a data: import, the
// same way nav-fixture does, then load navPresets against that module.
const raw = fs.readFileSync(SRC + '/navConfig.jsx', 'utf8')
const icons = [...new Set([...raw.matchAll(/icon: ([A-Za-z0-9]+)/g)].map(m => m[1]))]
const navShim = raw.replace(/import\s*\{[\s\S]*?\}\s*from\s*'lucide-react'/,
  icons.map(i => `const ${i} = '${i}'`).join('; '))
const navUrl = 'data:text/javascript;base64,' + Buffer.from(navShim).toString('base64')
// navPresets reads lib/org.seed.json; a data: module cannot resolve a relative JSON import, so inline it.
const seedJson = fs.readFileSync(SRC + '/lib/org.seed.json', 'utf8')
const presetsSrc = fs.readFileSync(SRC + '/lib/navPresets.js', 'utf8').replace("import seed from './org.seed.json'", `const seed = ${seedJson}`)
  .replace("from '../navConfig'", `from '${navUrl}'`)
const { PRESETS, DEPARTMENTS, presetsForDepartment, unionPaths, addPaths } = await import(
  'data:text/javascript;base64,' + Buffer.from(presetsSrc).toString('base64'))
const { NAV_PAGES } = await import(navUrl)

let fail = 0
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++ }
const known = new Set(NAV_PAGES.map(p => p.path))
const hidden = new Set(NAV_PAGES.filter(p => p.hidden).map(p => p.path))
const by = Object.fromEntries(PRESETS.map(p => [p.key, p]))

console.log('1. every preset grants only pages that exist')
for (const p of PRESETS) {
  const missing = p.paths.filter(x => !known.has(x))
  ok(missing.length === 0, `${p.key.padEnd(11)} ${p.paths.length} paths, all in NAV_PAGES${missing.length ? ' — MISSING: ' + missing.join(', ') : ''}`)
  ok(new Set(p.paths).size === p.paths.length, `${p.key.padEnd(11)} no duplicates`)
}

console.log('\n2. what everyone gets (John, 2026-09-18: Flags is for everyone)')
for (const p of PRESETS) {
  ok(['/', '/my-work', '/messages', '/calendar', '/flags'].every(x => p.paths.includes(x)),
     `${p.key.padEnd(11)} carries Home, My Work, Messages, Calendar, Flags`)
}

console.log('\n3. the plan grid')
ok(!by.anr.paths.some(x => x.startsWith('/bk/')) && !by.anr.paths.includes('/reports'),
   'anr         has no money pages')
ok(by.anr.paths.includes('/contracts') && by.anr.paths.includes('/deals') && by.anr.paths.includes('/create-nda'),
   'anr         has contracts, deals and the document generators')
ok(by.marketing.paths.includes('/bk/add') && !by.marketing.paths.includes('/bk/approvals') && !by.marketing.paths.includes('/bk/payments'),
   'marketing   has the Add tab only, never the queues')
ok(by.marketing.paths.includes('/artist-budgets') && by.marketing.paths.includes('/artist-campaigns'),
   'marketing   has Artist Spend')
ok(!by.bookkeeper.paths.includes('/artists') && !by.bookkeeper.paths.includes('/releases'),
   'bookkeeper  has no roster or release tracking')
ok(['/bk/approvals', '/bk/payments', '/bk/ledger', '/bk/statements', '/bk/vendors', '/reports', '/recoupments'].every(x => by.bookkeeper.paths.includes(x)),
   'bookkeeper  has Invoices, Bank, Vendors, Reports, Recoupments')
ok(NAV_PAGES.every(p => by.ops.paths.includes(p.path)), `ops         has every page (${by.ops.paths.length})`)
for (const k of ['anr', 'marketing', 'bookkeeper']) {
  const leaked = by[k].paths.filter(x => hidden.has(x))
  ok(leaked.length === 0, `${k.padEnd(11)} grants no hidden page${leaked.length ? ' — ' + leaked.join(', ') : ''}`)
}

console.log('\n4. presets are ADDITIVE')
const both = unionPaths(['anr', 'marketing'])
ok(by.anr.paths.every(x => both.includes(x)) && by.marketing.paths.every(x => both.includes(x)),
   `anr + marketing is a superset of each (${both.length} paths)`)
ok(new Set(both).size === both.length, 'and carries no duplicates')
ok(both.length < by.anr.paths.length + by.marketing.paths.length, 'and the overlap was folded, not doubled')
ok(unionPaths(['nope']).length === 0, 'an unknown key contributes nothing')
const grown = addPaths(new Set(['/bk/ledger']), by.anr.paths)
ok(grown.has('/bk/ledger') && grown.has('/artists'), 'addPaths keeps what was already ticked and adds the preset')
ok(!addPaths(new Set(), ['/does-not-exist']).has('/does-not-exist'), 'addPaths drops a path the app does not have')

console.log('\n5. departments seed the default tick')
ok(JSON.stringify(DEPARTMENTS) === JSON.stringify(['Executive', 'A&R', 'Marketing', 'Finance', 'Operations']), `departments: ${DEPARTMENTS.join(', ')}`)
ok(presetsForDepartment('Executive').join() === 'executive' && unionPaths(['executive']).includes('/reports') && !unionPaths(['executive']).includes('/bk/approvals'), 'Executive → the executive preset: reports yes, approval queue no')
for (const d of DEPARTMENTS) {
  const keys = presetsForDepartment(d)
  ok(keys.length === 1 && by[keys[0]] && by[keys[0]].department === d, `${d.padEnd(11)} → ${keys.join(', ')}`)
}
ok(presetsForDepartment('Legal').length === 0, 'an unknown department seeds nothing rather than guessing')

console.log('\n6. a User holding a preset reaches its pages and nothing more (real canViewPath)')
const knownPages = known
const asUser = (keys) => ({ role: 'User', pagePermissions: unionPaths(keys), knownPages })
const reach = (ctx) => NAV_PAGES.map(p => p.path).filter(p => canViewPath(p, ctx))
const anrReach = reach(asUser(['anr']))
ok(anrReach.includes('/releases') && anrReach.includes('/contracts') && !anrReach.includes('/bk/ledger') && !anrReach.includes('/reports'),
   `anr User reaches releases and contracts, not the ledger or reports (${anrReach.length} pages)`)
const mktReach = reach(asUser(['marketing']))
ok(mktReach.includes('/bk/add') && !mktReach.includes('/bk/approvals'), 'marketing User reaches Add, not Approvals')
ok(reach(asUser(['anr', 'marketing'])).length === new Set([...anrReach, ...mktReach]).size,
   'a User holding both reaches exactly the union of the two')
ok(canViewPath('/artists/42', asUser(['anr'])) && !canViewPath('/bk/vendors/ACME', asUser(['anr'])),
   'detail routes follow their index page')

console.log(fail ? `\n${fail} FAILED` : '\nall assertions passed')
process.exit(fail ? 1 : 0)
