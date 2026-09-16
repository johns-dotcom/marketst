#!/usr/bin/env node
/**
 * Render a page component in node, so a render-time throw is caught before it
 * reaches a browser.
 *
 * ── Why this exists ──
 * `vite build` says `✓ built` on a page that renders NOTHING. On 2026-08-19 a
 * create-invoice change read a `const` nine lines above its own declaration — a
 * temporal-dead-zone ReferenceError thrown on every render — and shipped on a green
 * build, because a build checks that names RESOLVE, not that a component EXECUTES.
 * The identifier existed; it just did not exist yet. Reinstating that bug here
 * prints:
 *
 *     ✓ built in 6.05s
 *     THREW  src/pages/CreateInvoice.jsx  Cannot access 'editingInvoice' before initialization
 *
 * This is NOT a test runner and the repo deliberately has none (see CLAUDE.md). It
 * asserts one thing: the component's body runs. Effects never fire under
 * renderToString, so nothing here talks to a database or an API — which also means
 * a page renders in its LOADING state here (CreateInvoice emits 255 bytes of
 * skeleton). Anything reachable only after data arrives is NOT covered. The class
 * of bug it does catch is the one that took the page out entirely: a throw in the
 * component body, before any branch.
 *
 * ── The gap this had, and the check that closes half of it ──
 * On 2026-08-20 the Ledger went white on a green smoke run. The cause was the same
 * temporal-dead-zone shape as CreateInvoice's:
 *
 *     const selectedRows = renderable.filter(e => selected.has(e.id))   // line 2229
 *     const [selected, setSelected] = useState(() => new Set())         // line 2403
 *
 * It passed here because in the loading state `renderable` is `[]`, and
 * `[].filter(cb)` never invokes `cb` — so the dead-zone read never happened. With
 * rows on screen it threw on every render.
 *
 * ARRAY_CALLBACK_TDZ below greps the source for that shape: an array method whose
 * callback reads an identifier declared LOWER in the same function. It is a
 * heuristic, not a type checker, and it only looks at page files — but it catches
 * the exact bug that shipped twice, and it costs nothing to run.
 *
 * ── Usage, from boom-dashboard/client ──
 *     npm run smoke                          # every page changed vs HEAD
 *     npm run smoke -- src/pages/Reports.jsx # named pages
 *
 * ── Three things that make it work ──
 *  · The SSR bundle EXTERNALIZES react, so it must be built and run inside
 *    client/ — node resolves a bare specifier from the importing file's directory,
 *    and a bundle in /tmp resolves nothing.
 *  · Browser globals are shimmed BEFORE the bundle is imported, because
 *    AuthContext reads localStorage in its component body.
 *  · esbuild's binary in node_modules/.bin is the wrong arch here ("exec format
 *    error"), so the bundling goes through vite, which is known to work.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORK = path.join(CLIENT, '.smoke')

const pagesFromGit = () => {
  const out = []
  for (const args of [['diff', '--name-only', 'HEAD', '--', 'src/pages'],
    ['diff', '--name-only', '--cached', '--', 'src/pages']]) {
    try {
      out.push(...execFileSync('git', args, { cwd: CLIENT, encoding: 'utf8' })
        .split('\n').map((s) => s.trim()).filter(Boolean))
    } catch { /* not a repo, or no changes */ }
  }
  // git reports paths from the repo root; keep only page files and re-anchor.
  return [...new Set(out)]
    .filter((p) => /\/pages\/.+\.jsx$/.test(p))
    .map((p) => 'src' + p.split('/src').pop())
}

const args = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const explicit = args.length > 0
let pages = (args.length ? args : pagesFromGit())
  .map((p) => p.replace(/^.*?(src\/pages\/)/, '$1'))
  .filter((p, i, a) => a.indexOf(p) === i)

if (!pages.length) {
  console.log('smoke-render: no changed pages under src/pages — nothing to render.')
  console.log('              pass paths explicitly to force it, e.g. npm run smoke -- src/pages/Reports.jsx')
  process.exit(0)
}
// A page the diff names but that is GONE was DELETED in this change, which is a
// normal thing to do and not a reason to render nothing. This used to exit(2) on
// the first one — so deleting a page turned the whole run into a no-op that
// still exited non-zero-free at the call site, and the pages you actually
// changed went unrendered. An explicitly-named missing path is still an error,
// because that one is a typo.
const missing = pages.filter((p) => !existsSync(path.join(CLIENT, p)))
if (missing.length && explicit) {
  for (const p of missing) console.error(`smoke-render: ${p} does not exist`)
  process.exit(2)
}
if (missing.length) {
  for (const p of missing) console.log(`smoke-render: skipping ${p} (deleted in this change)`)
  pages = pages.filter((p) => existsSync(path.join(CLIENT, p)))
  if (!pages.length) {
    console.log('smoke-render: every changed page was deleted — nothing to render.')
    process.exit(0)
  }
}

// ── the entry ───────────────────────────────────────────────────────────────
// The same provider stack main.jsx and App.jsx render under, minus the Google
// OAuth provider (it needs a client id and no page reads it). A page that only
// needs a Router still works — extra providers are inert.
const imports = pages.map((p, i) => `import Page${i} from '../${p}'`).join('\n')
const cases = pages.map((p, i) => `  { name: ${JSON.stringify(p)}, Page: Page${i} }`).join(',\n')
mkdirSync(WORK, { recursive: true })
writeFileSync(path.join(WORK, 'entry.jsx'), `import React from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '../src/context/ThemeContext'
import { ToastProvider } from '../src/context/ToastContext'
import { AuthProvider } from '../src/context/AuthContext'
import { FxRatesProvider } from '../src/context/FxRatesContext'
import { BoomRepsProvider } from '../src/context/BoomRepsContext'
import { CategoriesProvider } from '../src/context/CategoriesContext'
// Login uses Google SSO, and its hook throws outside this provider — main.jsx
// wraps the whole app in it. Without it here, Login reported THREW on every full
// sweep, which is a standing false failure and the fastest way to teach someone
// to ignore this script's output.
import { GoogleOAuthProvider } from '@react-oauth/google'
${imports}

const CASES = [
${cases}
]

const wrap = (Page) => React.createElement(
  MemoryRouter, { initialEntries: ['/'] },
  React.createElement(GoogleOAuthProvider, { clientId: '' },
  React.createElement(ThemeProvider, null,
    React.createElement(ToastProvider, null,
      React.createElement(AuthProvider, null,
        React.createElement(FxRatesProvider, null,
          React.createElement(BoomRepsProvider, null,
            React.createElement(CategoriesProvider, null,
              React.createElement(Page, {})))))))))

export function run() {
  return CASES.map(({ name, Page }) => {
    try {
      const html = renderToString(wrap(Page))
      return { name, ok: true, bytes: html.length }
    } catch (err) {
      return { name, ok: false, message: (err && err.message) || String(err) }
    }
  })
}
`)

// ── bundle for node ─────────────────────────────────────────────────────────
try {
  execFileSync('npx', ['vite', 'build', '--ssr', '.smoke/entry.jsx', '--outDir', '.smoke/out',
    '--emptyOutDir', '--logLevel', 'error'], { cwd: CLIENT, stdio: 'inherit' })
} catch {
  console.error('\nsmoke-render: the bundle itself failed — that is a compile error, not a render error.')
  rmSync(WORK, { recursive: true, force: true })
  process.exit(2)
}

// ── browser globals, before the bundle loads ────────────────────────────────
const store = new Map()
const localStorageShim = {
  getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
  setItem: (k, v) => store.set(String(k), String(v)),
  removeItem: (k) => store.delete(String(k)),
  clear: () => store.clear(),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size },
}
globalThis.localStorage = localStorageShim
globalThis.sessionStorage = localStorageShim
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
globalThis.window = globalThis
// A page or a context can read location/history at module scope (api.js does).
if (!('location' in globalThis)) {
  globalThis.location = { href: 'http://localhost/', origin: 'http://localhost',
    protocol: 'http:', host: 'localhost', hostname: 'localhost', port: '',
    pathname: '/', search: '', hash: '', assign() {}, replace() {}, reload() {} }
}
if (!('history' in globalThis)) {
  globalThis.history = { length: 1, state: null, pushState() {}, replaceState() {}, back() {}, forward() {}, go() {} }
}
globalThis.document = {
  documentElement: { classList: { add() {}, remove() {}, contains: () => false, toggle() {} }, style: {}, setAttribute() {} },
  body: { classList: { add() {}, remove() {} }, style: {} },
  addEventListener() {}, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
}
// node >= 21 defines `navigator` as a getter-only property, so assigning to it
// throws. Only define one where the runtime has none.
if (!('navigator' in globalThis)) globalThis.navigator = { userAgent: 'smoke-render' }

// React logs a useLayoutEffect warning per component under SSR. It is noise here
// and would bury the one line that matters.
const realWarn = console.warn
const realError = console.error
const quiet = (fn) => (...a) => { if (/useLayoutEffect|not supported in the server/i.test(String(a[0] || ''))) return; fn(...a) }
console.warn = quiet(realWarn)
console.error = quiet(realError)

let results
try {
  const mod = await import(path.join(WORK, 'out', 'entry.js'))
  results = mod.run()
} catch (err) {
  console.warn = realWarn; console.error = realError
  console.error(`smoke-render: could not load the bundle — ${err && err.message}`)
  rmSync(WORK, { recursive: true, force: true })
  process.exit(2)
}
console.warn = realWarn
console.error = realError
rmSync(WORK, { recursive: true, force: true })

// ── ARRAY_CALLBACK_TDZ ──────────────────────────────────────────────────────
// The half of the gap a render can't see: an array-method callback that reads an
// identifier declared further down the same function. Empty data never invokes
// the callback, so the render passes; real data throws on every pass.
//
// Deliberately narrow: a one-line `const NAME = <expr>.filter|map|…(cb)` whose
// callback reads a STATE variable declared lower in the file. Anything wider
// flagged callback parameters and honest closures — noise that gets a check
// ignored, which is worse than not having it.
const ARRAY_METHODS = 'filter|map|some|every|find|findIndex|reduce|flatMap|forEach|sort'
const tdzFindings = []
for (const rel of pages) {
  const lines = readFileSync(path.join(CLIENT, rel), 'utf8').split('\n')
  // STATE only: `const [x, setX] = useState(...)`. That is the hazard — state
  // conventionally sits in a block at the top or the middle of a component, and a
  // derivation written above it looks perfectly normal until data arrives. Widening
  // this to every `const` flagged callback parameters (`e`, `a`, `b`) and every
  // legitimate closure, which is noise that would get the whole check ignored.
  //
  // Bounded to the DEFAULT-EXPORTED component, for the same reason the hook check
  // is: a file-wide map reported two standing false positives — Financials:207
  // reads a `data` declared locally on line 200 while the page's state `data`
  // lives at 2044, and Settings has the same shape with `saved`. Both were noise
  // in every run that touched those files.
  const cStart = lines.findIndex((l) => /^export default function/.test(l))
  let cEnd = lines.length
  if (cStart >= 0) {
    for (let i = cStart + 1; i < lines.length; i += 1) {
      if (/^(?:function |const [A-Z]|class |export )/.test(lines[i])) { cEnd = i; break }
    }
  }
  const inComponent = (i) => cStart < 0 || (i >= cStart && i < cEnd)
  const declaredAt = new Map()
  lines.forEach((l, i) => {
    if (!inComponent(i)) return
    const m = l.match(/^\s*const\s*\[\s*([A-Za-z_$][\w$]*)\s*,[^\]]*\]\s*=\s*useState/)
    if (m && !declaredAt.has(m[1])) declaredAt.set(m[1], i + 1)
  })
  lines.forEach((l, i) => {
    if (!inComponent(i)) return
    const call = new RegExp(`\\.(?:${ARRAY_METHODS})\\s*\\(`).test(l)
    if (!call) return
    const isDecl = /^\s*(?:const|let)\s/.test(l)
    if (!isDecl) return
    for (const [name, declLine] of declaredAt) {
      if (declLine <= i + 1) continue
      // NOT preceded by a dot or a word char: `Object.entries(...)` must not
      // match a state variable called `entries`, and `myEntries` must not match
      // `entries`. That false positive fired on Recoupments the first time this
      // check ran, which is how a noisy check gets switched off.
      if (!new RegExp(`(?<![.\\w$])${name}\\b`).test(l)) continue
      // The declaration on THIS line is obviously not a forward read.
      if (new RegExp(`^\\s*(?:const|let)\\s*\\[?\\s*${name}\\b`).test(l)) continue
      tdzFindings.push({ file: rel, line: i + 1, name, declLine, src: l.trim().slice(0, 110) })
    }
  })
}

// ── HOOK_AFTER_RETURN ───────────────────────────────────────────────────────
// React counts hooks per render. A hook BELOW an early `return` runs on some
// renders and not others, and the first render that reaches it throws
//   "Rendered more hooks than during the previous render"
// which is a white page. My Work shipped exactly this on 2026-08-25: a
// `useEffect` sat below `if (loading) return <Skeleton…>`, so the loading render
// stopped short of it and the render after the fetch reached it.
//
// This is the OTHER half of the gap a render cannot see, and it is worse than the
// TDZ one: renderToString only ever renders the loading branch — the single
// branch in which the bug does not exist — so the page smoke-tests green and is
// blank in a browser the moment data arrives.
//
// Mechanical and cheap: find a top-level `return` inside the component (indented
// two spaces, which is this codebase's convention for a component-body
// statement), then any hook call after it. Hooks inside nested functions are
// indented further and are not flagged.
const HOOKS = 'useState|useEffect|useMemo|useCallback|useRef|useReducer|useContext|useLayoutEffect|use[A-Z][\\w$]*'
const hookFindings = []
for (const rel of pages) {
  const lines = readFileSync(path.join(CLIENT, rel), 'utf8').split('\n')
  // Scoped to the DEFAULT-EXPORTED component. Without this anchor the check fired
  // on `return`s inside module-level helper functions — MyWork has one on line 34
  // — and reported every hook in the component as "after a return", which is the
  // kind of noise that gets a check deleted.
  const start = lines.findIndex((l) => /^export default function/.test(l))
  if (start < 0) continue
  // …and STOPPING at the next top-level declaration. Without an end bound this
  // swept up every helper component defined lower in the same file and reported
  // 100+ findings across 12 pages, none of them real — AdAllocation's
  // NewCampaignForm, ArtistCampaigns' dozen sub-components. A check that noisy is
  // a check that gets switched off, which the note on ARRAY_CALLBACK_TDZ above
  // already says once.
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^(?:function |const [A-Z]|class |export )/.test(lines[i])) { end = i; break }
  }
  // An early return in this codebase takes one of three shapes, and the first
  // version of this check only matched the first — so it MISSED the very bug it
  // was written for, because `if (loading) {` puts the return on the next line at
  // FOUR spaces of indent:
  //
  //     if (loading) return <Skeleton />        // guard, one line
  //     if (loading) {                          // guard, block  ← the one it missed
  //       return (…)
  //     }
  //     return (…)                              // the real render
  const isEarlyReturn = (i) => {
    const l = lines[i]
    if (/^ {2}return[\s(]/.test(l)) return true
    if (/^ {2}if\s*\(.*\)\s*return[\s(]/.test(l)) return true
    if (/^ {2}if\s*\(/.test(l)) {
      for (let k = i + 1; k <= i + 3 && k < lines.length; k += 1) {
        if (/^ {4}return[\s(]/.test(lines[k])) return true
        if (/^ {2}\}/.test(lines[k])) break
      }
    }
    return false
  }
  let earlyReturn = null
  for (let i = start; i < end; i += 1) {
    const l = lines[i]
    if (earlyReturn === null && isEarlyReturn(i)) {
      // The LAST return in a component is the real render, so a hook only matters
      // if it comes after the FIRST one.
      earlyReturn = i + 1
    }
    if (earlyReturn === null) continue
    const m = l.match(new RegExp(`^ {2}(?:const\\s+[^=]+=\\s*)?(${HOOKS})\\s*\\(`))
    if (m) hookFindings.push({ file: rel, line: i + 1, hook: m[1], returnLine: earlyReturn, src: l.trim().slice(0, 100) })
  }
}

console.log('')
let failed = 0
for (const r of results) {
  if (r.ok) console.log(`  ok     ${r.name}  ·  ${r.bytes} bytes`)
  else { failed += 1; console.log(`  THREW  ${r.name}  ·  ${r.message}`) }
}
console.log('')
// Reported, NOT exited on — the static checks below have to run too. A render
// failure used to short-circuit them, so one page throwing hid every hook and TDZ
// finding in the rest of the run (Login throws under this harness for a reason
// that is not a bug: it needs GoogleOAuthProvider, which App.jsx supplies).
if (failed) {
  console.log(`${failed} of ${results.length} page(s) threw during render — a browser would show a blank page.`)
}
if (hookFindings.length) {
  console.log('')
  console.log('  Hooks called AFTER an early return — these change the hook count between')
  console.log('  renders and blank the page as soon as the early return stops being taken:')
  for (const f of hookFindings) {
    console.log(`    ${f.file}:${f.line}  ${f.hook}() after the return on line ${f.returnLine}`)
    console.log(`      ${f.src}`)
  }
  console.log('')
}
if (tdzFindings.length) {
  console.log('')
  console.log('  Array callbacks reading an identifier declared BELOW them — these render')
  console.log('  fine on empty data and throw as soon as a row exists:')
  for (const f of tdzFindings) {
    console.log(`    ${f.file}:${f.line}  reads \`${f.name}\` (declared line ${f.declLine})`)
    console.log(`      ${f.src}`)
  }
  console.log('')
}
console.log(`${results.length} page(s) rendered.`)

// One exit for the whole run, so every check gets to speak.
process.exit(failed || hookFindings.length || tdzFindings.length ? 1 : 0)
