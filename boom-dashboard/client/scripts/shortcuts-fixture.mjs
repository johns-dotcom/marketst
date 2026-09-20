#!/usr/bin/env node
/**
 * The keyboard vocabulary (src/lib/shortcuts.js) against the nav and the tours.
 *
 *   cd client && npm run shortcuts-fixture
 *
 * Fails when a page in PAGE_KEYS or GOTO is not a nav page (a key that jumps
 * nowhere), when a page binds one key twice, when a global key (? / g) is
 * reused on a page, when a page tour with keys lacks its "Keys on this page"
 * step, or when a page that calls usePageShortcuts binds a key the vocabulary
 * does not list (grep over the sources: the hook refuses it at runtime, but a
 * silent refusal is what this exists to catch).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src', import.meta.url))
let failed = 0
const ok = (cond, msg) => { console.log(`${cond ? '  ok  ' : '  FAIL'} ${msg}`); if (!cond) failed += 1 }

const rawNav = fs.readFileSync(SRC + '/navConfig.jsx', 'utf8')
const shimNav = rawNav.replace(/import\s*\{[\s\S]*?\}\s*from\s*'lucide-react'/, (m) => {
  const names = m.replace(/import\s*\{|\}\s*from\s*'lucide-react'/g, '').split(',').map((x) => x.trim()).filter(Boolean)
  return names.map((n) => `const ${n} = () => null`).join('\n')
})
const navUrl = 'data:text/javascript;base64,' + Buffer.from(shimNav).toString('base64')
const { NAV_PAGES } = await import(navUrl)
const keysUrl = 'data:text/javascript;base64,' + Buffer.from(fs.readFileSync(SRC + '/lib/shortcuts.js', 'utf8')).toString('base64')
const { PAGE_KEYS, GOTO, GLOBAL_KEYS, keysSentence } = await import(keysUrl)
const rawTours = fs.readFileSync(SRC + '/tours/index.js', 'utf8').replace("from '../navConfig'", `from '${navUrl}'`).replace("from '../lib/shortcuts'", `from '${keysUrl}'`)
const { TOURS } = await import('data:text/javascript;base64,' + Buffer.from(rawTours).toString('base64'))

const navPaths = new Set(NAV_PAGES.map((p) => p.path))
console.log('1. every page with keys, and every go-to target, is a nav page')
for (const p of Object.keys(PAGE_KEYS)) ok(navPaths.has(p), `PAGE_KEYS ${p}`)
for (const [letter, p, label] of GOTO) ok(navPaths.has(p), `g ${letter} → ${p} (${label})`)
ok(new Set(GOTO.map(([l]) => l)).size === GOTO.length, 'no two go-to destinations share a letter')

console.log('\n2. no page binds one key twice, and none reuses a global key')
const globalSpecs = new Set(GLOBAL_KEYS.map((k) => k.spec).concat(['g']))
for (const [p, list] of Object.entries(PAGE_KEYS)) {
  const specs = list.map((k) => k.spec)
  ok(new Set(specs).size === specs.length, `${p}: ${specs.length} keys, all distinct`)
  ok(!specs.some((s) => globalSpecs.has(s)), `${p}: none of ${[...globalSpecs].join(' ')} is rebound`)
  ok(list.every((k) => k.label && k.label.length > 2), `${p}: every key has a label`)
}

console.log('\n3. every page tour with keys ends on them, from the same list')
for (const t of TOURS) {
  if (t.id === 'welcome' || !PAGE_KEYS[t.path] || t.match) continue
  const last = t.steps[t.steps.length - 1]
  ok(last.title === 'Keys on this page' && last.body.startsWith(keysSentence(t.path)), `${t.id}: last step is the keys, verbatim from PAGE_KEYS`)
  ok(t.version >= '2026-09-22', `${t.id}: version bumped for the keys step (${t.version})`)
}
const welcome = TOURS.find((t) => t.id === 'welcome')
ok(welcome.steps.some((s) => /g then a letter/.test(s.body)), 'the welcome walk teaches g-then-letter')

console.log('\n4. every usePageShortcuts call binds only keys the vocabulary lists')
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)])
const files = walk(SRC + '/pages').filter((f) => /\.jsx?$/.test(f))
let calls = 0
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8')
  const m = src.match(/usePageShortcuts\('([^']+)'/g)
  if (!m) continue
  for (const c of m) {
    calls += 1
    const p = c.match(/'([^']+)'/)[1]
    ok(!!PAGE_KEYS[p], `${path.relative(SRC, f)}: usePageShortcuts('${p}') names a page in PAGE_KEYS`)
  }
  ok(!/useHotkeys\(\[/.test(src), `${path.relative(SRC, f)}: no bare useHotkeys left beside usePageShortcuts (keys the help cannot see)`)
}
ok(calls >= 15, `${calls} pages bind their keys through usePageShortcuts`)

console.log(`\n${failed ? `${failed} FAILED` : 'all assertions passed'}`)
process.exit(failed ? 1 : 0)
