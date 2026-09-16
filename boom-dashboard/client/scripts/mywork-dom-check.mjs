#!/usr/bin/env node
/**
 * Mount a page in a REAL DOM so effects run and the data branches execute.
 *
 * ── Why this exists next to smoke-render.mjs ──
 * smoke renders with `renderToString`, where effects never fire. A page that
 * fetches its data therefore renders in its LOADING branch and nothing else —
 * which is the one branch a data-dependent bug is not in. On 2026-08-25 My Work
 * shipped a `useEffect` below `if (loading) return <Skeleton/>`; the loading
 * render stopped short of the hook and the render after the fetch reached it, so
 * React threw "Rendered more hooks than during the previous render" and the page
 * was WHITE. smoke was green the whole time.
 *
 * This mounts with react-dom/client under jsdom against a stubbed api, waits for
 * the fetch to resolve, and prints whatever actually threw — with a stack.
 *
 * smoke now also greps for that shape (HOOK_AFTER_RETURN), which is cheaper and
 * runs on every page. This is the tool for when the grep is not enough: it tells
 * you what a browser would do.
 *
 * ── jsdom is NOT a dependency ──
 * Deliberately: it is a large tree and this is an occasional diagnostic, not part
 * of the build. Install it wherever you like and point JSDOM_PATH at it.
 *
 *     mkdir -p /tmp/domtest && cd /tmp/domtest && npm init -y && npm i jsdom
 *     cd <repo>/boom-dashboard/client
 *     npx vite build -c scripts/mywork-dom.vite.config.mjs
 *     JSDOM_PATH="file:///tmp/domtest/node_modules/jsdom/lib/api.js" \
 *       node scripts/mywork-dom-check.mjs .domsmoke/out/mywork-dom-entry.js
 */
const jsdomPath = process.env.JSDOM_PATH
const bundle = process.argv[2]
if (!jsdomPath || !bundle) {
  console.error('usage: JSDOM_PATH=file:///…/jsdom/lib/api.js node scripts/mywork-dom-check.mjs <bundle.js>')
  console.error('see the header of this file for the two-step setup')
  process.exit(2)
}
const { JSDOM } = await import(jsdomPath)
// PAGE_URL matters for any page that reads its own query string —
// BkBankMatching takes `?statement=` from window.location, and without it the
// harness gets every month at once. Defaults to the My Work path this file
// was written for.
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
  { url: process.env.PAGE_URL || 'http://localhost/my-work', pretendToBeVisual: true })
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node',
  'getComputedStyle', 'MutationObserver', 'CustomEvent', 'Event', 'localStorage',
  'sessionStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'DOMRect']) {
  if (dom.window[k] === undefined) continue
  // node 24 makes some of these getter-only on globalThis.
  try { globalThis[k] = dom.window[k] }
  catch { Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true }) }
}
// jsdom implements no CSS Object Model media queries, so `window.matchMedia` is
// undefined and any page using useIsMobile throws on its first render — which
// looks exactly like a broken page. Desktop by default; a harness that wants the
// mobile branch can override the query result before mounting.
if (typeof dom.window.matchMedia !== 'function') {
  const mql = (query) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })
  dom.window.matchMedia = mql
  globalThis.matchMedia = mql
}
globalThis.IS_REACT_ACT_ENVIRONMENT = false
// scrollTo is called by pages that move focus; jsdom logs "Not implemented"
// through console.error, which a harness collecting console.error reports as an
// error the page did not have.
dom.window.scrollTo = () => {}
await import(bundle.startsWith('/') ? bundle : `${process.cwd()}/${bundle}`)
// The bundle's own timer prints the result; give it room to fire.
await new Promise((r) => setTimeout(r, 2600))
// WAIT_FOR_DONE: a harness that clicks through several round trips to a real
// server cannot finish inside a fixed wait, so it sets globalThis.__DONE__ and
// this polls for it. Opt-in — without it the behaviour is exactly as before.
if (process.env.WAIT_FOR_DONE) {
  const deadline = Date.now() + Number(process.env.WAIT_MS || 40000)
  while (!globalThis.__DONE__ && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250))
  if (!globalThis.__DONE__) console.log('TIMED OUT before the harness finished')
  process.exit(0)
}
