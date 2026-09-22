// The sidebar's invariants, asserted in node.
//
// The nav is a config file that four different consumers read: the sidebar,
// Settings' permission matrix, the ⌘K palette, and TabbedShell. A page dropped
// from the config is not merely hidden — it becomes ungrantable in Settings and
// unfindable in the palette. This file exists to make that impossible to do by
// accident.
//
// History worth keeping: the nine-group reorganization and the four renames that
// shipped on 2026-08-24 were REVERTED the same day at John's request. The
// assertions that encoded them are gone; the ones that protect the config from
// losing a page are not, because those were never about the grouping.

import { fileURLToPath } from 'node:url'
import fs from 'fs'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

// Load navConfig without React by stubbing lucide-react through a data: import.
const raw = fs.readFileSync(SRC + '/navConfig.jsx', 'utf8')
const icons = [...new Set([...raw.matchAll(/icon: ([A-Za-z0-9]+)/g)].map(m => m[1]))]
const shim = raw.replace(/import\s*\{[\s\S]*?\}\s*from\s*'lucide-react'/,
  icons.map(i => `const ${i} = '${i}'`).join('; '))
const { NAV_GROUPS, NAV_PAGES } = await import(
  'data:text/javascript;base64,' + Buffer.from(shim).toString('base64'))

let fail = 0
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++ }

// Both container kinds flatten to their children. A `tabbed` family and a
// `collapsible` drawer are one ROW each but several PAGES each.
const flat = (g) => g.items.flatMap(i => (i.collapsible || i.tabbed) ? i.children : [i])
const allPaths = NAV_GROUPS.flatMap(flat).map(i => i.path)

console.log('1. no page can go missing')
ok(allPaths.length === 50, `50 paths across ${NAV_GROUPS.length} groups (got ${allPaths.length}) — Boom's 53 minus the five John removed outright on 2026-09-18, plus Brand (2026-09-19), plus Song campaigns (2026-09-21)`)
ok(new Set(allPaths).size === allPaths.length, 'no path appears twice')
ok(NAV_PAGES.length === 50, "NAV_PAGES flattens to 50 — Settings' permission matrix renders from it, so a new page must appear here or nobody can ever be granted it")
// market.st regroup (2026-09-18): pages leave the SIDEBAR with `hidden`,
// never by deletion. A hidden page is still grantable, still searchable, and
// still a known page for the permission walk.
const hiddenRows = NAV_PAGES.filter(p => p.hidden).map(p => p.path).sort()
const expectHidden = ['/activity', '/admin/vendor-lab', '/analytics', '/bk/bulk-deals', '/bk/invoices', '/bk/ledger-matching', '/bk/reimburse', '/budget', '/financials', '/salary', '/team'].sort()
ok(JSON.stringify(hiddenRows) === JSON.stringify(expectHidden), `exactly these pages are hidden from the sidebar: ${hiddenRows.join(', ')}`)
const famKeys = NAV_GROUPS.flatMap(g => g.items.filter(i => i.tabbed).map(i => i.key))
ok(new Set(famKeys).size === famKeys.length, `tab family keys are unique (${famKeys.join(', ')})`)
ok(famKeys.includes('banking') && famKeys.includes('vendors') && famKeys.includes('recoupments'), 'the three pre-existing family keys survive — BankShell and the bankshell harness name `banking`')
const visibleRows = NAV_GROUPS.flatMap(g => g.items.filter(i => !i.hidden)).length
ok(visibleRows <= 16, `at most 16 sidebar rows for an admin (got ${visibleRows}) — the whole point of the regroup`)
ok(NAV_PAGES.every(p => p.path && p.label && p.group), 'every NAV_PAGES row has path + label + group')
ok(NAV_PAGES.every(p => p.synonyms), 'every row carries ⌘K synonyms')

console.log('\n2. group sizes (reported, not asserted)')
// Deliberately NOT bounded. The split that held every group to 8 rows was
// reverted by request — Bookkeeping is a 13-row group again by choice, and a
// bound here would be a test defending a decision that was undone.
for (const g of NAV_GROUPS) {
  console.log(`         ${String(g.label || '(pinned)').padEnd(14)} ${String(g.items.length).padStart(2)} rows, ${String(flat(g).length).padStart(2)} pages`)
}
const railRows = NAV_GROUPS.reduce((n, g) => n + g.items.length, 0)
ok(railRows < allPaths.length,
   `rail is ${railRows} rows for ${allPaths.length} pages — the four tab families close the gap`)

console.log('\n3. every path opens exactly one group (longest match wins)')
// Mirrors nothing in Layout any more — the accordion was reverted — but a path
// owned by two groups still means an ambiguous mental model, and it is the test
// that caught /import/master-sheet being claimed by both Bank and Artists.
const owns = (p, here) => p !== '/' && (here === p || here.startsWith(p + '/'))
const groupFor = (here) => {
  let best = null, len = -1
  for (const g of NAV_GROUPS) {
    if (!g.label) continue
    for (const i of flat(g)) if (owns(i.path, here) && i.path.length > len) { best = g.label; len = i.path.length }
  }
  return best
}
for (const path of allPaths) {
  const home = NAV_GROUPS.find(g => flat(g).some(i => i.path === path))
  const opened = groupFor(path)
  ok(!home.label || opened === home.label,
     `${path.padEnd(32)} → ${opened || '(pinned)'}${home.label && opened !== home.label ? `  but LIVES in ${home.label}` : ''}`)
}

console.log('\n4. tab families: one row, still several grantable pages')
const families = NAV_GROUPS.flatMap(g => g.items.filter(i => i.tabbed).map(i => ({ ...i, group: g.label })))
const navPaths = new Set(NAV_PAGES.map(p => p.path))
// Bumped from 2 when Vendors became a family (1099 Filing moved under it,
// 2026-09-02), from 3 when Banking did (2026-09-02), and from 4 to 9 for the
// market.st regroup (2026-09-18: releases, contracts, documents, invoices,
// artist-spend, settings; the `import` family folded into settings). These
// counts are canaries on purpose: they caught the 1099 page being ADDED the day
// before without this file being touched.
ok(families.length === 9, `${families.length} families (${families.map(f => `${f.key} in ${f.group}`).join(', ')})`)
for (const f of families) {
  ok(f.children.every(c => navPaths.has(c.path)),
     `every "${f.key}" tab is in NAV_PAGES — Settings can still grant each one`)
  ok(f.children.length >= 2, `"${f.key}" has ${f.children.length} tabs`)
  ok(!f.path, `"${f.key}" is a container, not a page of its own`)
}

console.log('\n5. the tab shells moved no URL')
const app = fs.readFileSync(SRC + '/App.jsx', 'utf8')
// Every tab of every family, plus the parameterized siblings the shells wrap.
// Two of the bank paths already carry a pageAccess carve-out, so a moved path
// there silently revokes a grant somebody is holding today.
const familyPaths = families.flatMap(f => f.children.map(c => c.path)).filter(p => p !== '/admin/vendor-lab')
for (const p of [...familyPaths, '/recoupments/:artistName', '/create-nda/:template',
                 '/artist-campaigns/:artistName', '/artist-campaigns/:artistName/:songName']) {
  ok(app.includes(`<Route path="${p}"`), `${p} still declared verbatim`)
}
// And each of those routes is wrapped in ITS family's shell (BankShell wraps
// the banking family itself), so a tab bar cannot name a page that renders
// without one — the mismatch that makes a family look like it lost a tab.
const esc = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
for (const f of families) {
  if (f.key === 'banking') continue
  for (const c of f.children) {
    if (c.external || c.hidden) continue
    // The settings family draws a rail (components/SettingsShell.jsx) instead
    // of a tab bar since 2026-09-19 — same wrapper idea, same untouched paths.
    const shell = f.key === 'settings' ? '<SettingsShell>' : '<TabbedShell family="' + f.key + '">'
    const re = new RegExp('<Route path="' + esc(c.path) + '"\\s+element=\\{[^\\n]*?' + esc(shell))
    ok(re.test(app), `${c.path.padEnd(28)} renders inside ${shell}`)
  }
}
// /recoupments/2025 is a routed orphan John asked to leave alone. It is a path
// DESCENDANT of /recoupments, so nested routes would have swallowed it — the
// wrapper approach is what keeps it untouched.
ok(/<Route path="\/recoupments\/2025" element=\{<Recoupments2025 \/>\}/.test(app),
   '/recoupments/2025 still routed and still unwrapped')
ok(!navPaths.has('/recoupments/2025'), 'and still absent from the nav, as it was')

console.log('\n6. the market.st layout (John, 2026-09-18)')
// Boom reverted an August regroup the same day; these are the decisions John
// made for market.st with the plan in front of him. Tab labels are short
// because the tab bar already says which family they are in.
const labelOf = (p) => NAV_GROUPS.flatMap(flat).find(i => i.path === p)?.label
const groupOf = (p) => NAV_GROUPS.find(g => flat(g).some(i => i.path === p))?.label
const familyOf = (p) => families.find(f => f.children.some(c => c.path === p))?.key
for (const [path, want] of [['/', 'Home'], ['/releases', 'Pipeline'], ['/deals', 'Deals'], ['/contracts', 'Active'],
                            ['/bk/add', 'Add'], ['/bk/creators', 'Creators'], ['/create-invoice', 'Invoice'],
                            ['/artist-budgets', 'Budgets'], ['/team', 'People']]) {
  ok(labelOf(path) === want, `${path.padEnd(18)} is "${labelOf(path)}"`)
}
for (const [path, fam] of [['/deals', 'contracts'], ['/create-invoice', 'documents'], ['/bk/creators', 'invoices'],
                           ['/bk/advertising', 'artist-spend'], ['/campaigns', 'artist-spend'], ['/activity', 'settings'], ['/team', 'settings']]) {
  ok(familyOf(path) === fam, `${path.padEnd(18)} is a tab of "${familyOf(path)}"`)
}
ok(groupOf('/bk/ledger') === 'Money' && groupOf('/bk/statements') === 'Money' && groupOf('/bk/vendors') === 'Money',
   'Invoices, Bank and Vendors share Money')
ok(groupOf('/reports') === 'Reports' && labelOf('/financials') === 'Financials' && NAV_PAGES.find(p => p.path === '/financials').hidden,
   'Reports leads; Financials is routed and grantable but not drawn')
ok(labelOf('/banking') === undefined && families.find(f => f.key === 'banking')?.label === 'Bank', 'the banking family is labelled Bank')
ok(NAV_GROUPS.map(g => g.label || '(pinned)').join(' · ') === '(pinned) · Artists & releases · Money · Reports · Admin',
   `groups in order: ${NAV_GROUPS.map(g => g.label || '(pinned)').join(' · ')}`)

console.log('\n7. ⌘K page search — the real ranking function, not a replica')
const { searchPages } = await import(SRC + '/lib/pageSearch.js')
const top = (q, canView) => searchPages(NAV_PAGES, q, canView).map(p => p.path)
for (const [q, want] of [['vendors', '/bk/vendors'], ['ledger', '/bk/ledger'], ['approvals', '/bk/approvals'],
                          ['reports', '/reports'], ['statements', '/bk/statements'], ['settings', '/settings']]) {
  ok(top(q)[0] === want, `"${q}" ranks ${want} first (got ${top(q)[0]})`)
}
ok(top('a').length === 0, 'one character returns nothing — no flicker on the first keystroke')
ok(top('zzzznope').length === 0, 'a miss returns nothing rather than everything')
ok(top('vendors').length <= 6, 'capped at 6')
// canView is applied BEFORE the cap. Asserting the gate BITES first, because an
// empty result would satisfy .every() over nothing — this assertion passed
// vacuously once already, on a single-character query.
const only = new Set(['/bk/vendors', '/bk/ledger', '/reports'])
const ungated = top('en')
const gated = top('en', (p) => only.has(p))
ok(ungated.length > gated.length, `"en" matches ${ungated.length} ungated, ${gated.length} gated — the gate bites`)
ok(gated.length > 0, `gated search still returns something (${gated.join(', ') || 'NOTHING'})`)
ok(gated.every(p => only.has(p)), 'and every one of them is permitted')

console.log('\n8. synonym reachability — finding a page by what you call it')
const find = (q) => NAV_GROUPS.flatMap(flat).filter(i =>
  (i.label + ' ' + i.path + ' ' + (i.synonyms || '')).toLowerCase().includes(q))
for (const [q, want] of [['w9', '/bk/vendors'], ['p&l', '/reports'], ['payroll', '/salary'],
                          ['recoup', '/recoupments'], ['duplicates', '/flags'],
                          ['bill a client', '/create-invoice']]) {
  ok(find(q).map(i => i.path).includes(want), `"${q}" finds ${want}`)
}

console.log(fail ? `\n${fail} FAILED` : '\nall assertions passed')
process.exit(fail ? 1 : 0)
