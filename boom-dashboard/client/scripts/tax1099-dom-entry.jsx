// Does the 1099 page put every vendor in the right bucket, and never show a TIN?
//
// smoke renders it in its loading state (3,253 bytes, no rows), so none of the
// bucketing runs there — and the bucketing IS the page: a vendor in the wrong
// one is either a form that does not get filed or a corporation that gets one
// it should not.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import Bk1099 from '../src/pages/Bk1099'
// Mounted the way App.jsx mounts it: inside the Vendors tab family. The page
// worked before the collapse; what this now also covers is that collapsing it
// did not cost it its chrome or its own tab.
import TabbedShell from '../src/components/TabbedShell'
import { calls } from './tax1099-api-stub.js'
import { ThemeProvider } from '../src/context/ThemeContext'
import { ToastProvider } from '../src/context/ToastContext'
import { FxRatesProvider } from '../src/context/FxRatesContext'

// FilePreview does not put the file's URL in the DOM — it fetches it into a
// blob and shows that instead. So the question "did the page ask the server for
// the right document" can only be answered by watching the fetch, which is also
// the only question worth asking: a plausible button pointing at the wrong
// entry opens another vendor's tax form.
export const fetched = []
const realFetch = globalThis.fetch
globalThis.fetch = (url, opts) => {
  fetched.push(String(url))
  // A 1x1 PNG, so the modal takes its success path rather than its error one.
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
  return Promise.resolve(new Response(png, { status: 200, headers: { 'content-type': 'image/png' } }))
}

const errors = []
window.addEventListener('error', (e) => errors.push('window.error: ' + e.message))
const origError = console.error
console.error = (...a) => { errors.push('console.error: ' + a.map(String).join(' ').slice(0, 300)) }

class Catch extends React.Component {
  constructor(p) { super(p); this.state = { err: null } }
  static getDerivedStateFromError(err) { return { err } }
  componentDidCatch(err) { errors.push('THROWN: ' + (err && err.message)) }
  render() { return this.state.err ? null : this.props.children }
}

createRoot(document.getElementById('root')).render(
  <MemoryRouter initialEntries={['/bk/1099']}>
    <ThemeProvider><ToastProvider><FxRatesProvider>
      <Catch><TabbedShell family="vendors"><Bk1099 /></TabbedShell></Catch>
    </FxRatesProvider></ToastProvider></ThemeProvider>
  </MemoryRouter>
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
const all = (sel) => [...document.querySelectorAll(sel)]
const text = () => document.body.textContent || ''
const rows = () => all('tbody tr').map((tr) => tr.textContent || '')
const tabTo = async (label) => {
  const b = all('button').find((x) => (x.textContent || '').startsWith(label))
  if (b) click(b)
  await sleep(250)
  return !!b
}
const say = (...a) => console.log(...a)

;(async () => {
  await sleep(1400)
  say('SETUP: the page loaded its year ->', calls.get.some((c) => c.url.startsWith('/bk/1099')))

  // ── the collapse: one Vendors row, this page as a tab under it ───────────
  const tabLinks = all('a').map((a) => ({ text: (a.textContent || '').trim(), href: a.getAttribute('href') }))
  const dirTab = tabLinks.find((t) => /Directory/.test(t.text))
  const taxTab = tabLinks.find((t) => /1099/.test(t.text))
  say('FAMILY: the shell offers a Directory tab ->', !!dirTab, dirTab?.href)
  say('FAMILY: …and a 1099 Filing tab ->', !!taxTab, taxTab?.href)
  say('FAMILY: the Directory tab points at /bk/vendors ->', dirTab?.href === '/bk/vendors')
  say('FAMILY: the 1099 tab keeps its own URL ->', taxTab?.href === '/bk/1099')
  // Being ON this page, its own tab must read as current — TabbedShell picks by
  // longest match, and both tabs are under /bk, so a sloppy match lights the
  // wrong one.
  const current = all('a').find((a) => /1099/.test(a.textContent || ''))
  say('FAMILY: and reads as the current tab ->',
    !!current && (current.getAttribute('aria-current') === 'page'
      || /border-ink|text-ink|font-bold|bg-/.test(current.className || '')),
    current?.className?.slice(0, 60))
  say('SUMMARY: it says how many get a form ->', /Gets a form/.test(text()))
  say('SUMMARY: and how many cannot be filed yet ->', /Cannot file yet/.test(text()))
  say('SUMMARY: the threshold caveat is shown ->', /\$2,000 for payments made after 2025/.test(text()))

  // Reportable: the four non-exempt over-threshold vendors, and NOT the others.
  const r = rows()
  say('REPORTABLE: lists the ready vendor ->', r.some((x) => x.includes('Ready Vendor')))
  say('REPORTABLE: lists the corporation that is still reportable ->', r.some((x) => x.includes('Law Corp')))
  say('REPORTABLE: and says why it is still in ->', r.some((x) => /Law Corp/.test(x) && /still reportable/.test(x)))
  say('REPORTABLE: excludes the C corporation ->', !r.some((x) => x.includes('Corp Vendor')))
  say('REPORTABLE: excludes the foreign payee ->', !r.some((x) => x.includes('Foreign Vendor')))
  say('REPORTABLE: excludes the under-threshold vendor ->', !r.some((x) => x.includes('Under Threshold')))
  say('REPORTABLE: a missing TIN is called out on the row ->',
    r.some((x) => /No TIN Vendor/.test(x) && /TIN/.test(x)))
  say('TIN: masked, and the full number is nowhere in the page ->',
    /•••••3333/.test(text()) && !/\b\d{9}\b/.test(text()))

  await tabTo('Needs attention')
  const chase = rows()
  say('CHASE: holds the two vendors missing something ->',
    chase.some((x) => x.includes('No TIN Vendor')) && chase.some((x) => x.includes('No W9 Vendor')),
    `(${chase.length} rows)`)
  say('CHASE: and not the vendor that is ready ->', !chase.some((x) => x.includes('Ready Vendor')))

  await tabTo('Excluded')
  const ex = rows()
  say('EXCLUDED: names both, with reasons ->',
    ex.some((x) => /Corp Vendor/.test(x) && /not 1099-reportable/.test(x))
    && ex.some((x) => /Foreign Vendor/.test(x) && /1042-S/.test(x)), `(${ex.length} rows)`)

  await tabTo('Under the threshold')
  say('UNDER: holds the small vendor ->', rows().some((x) => x.includes('Under Threshold')))

  // The scan loop: 14 unread across two batches of 10 then 4.
  await tabTo('Reportable')

  // ── the W-9 itself, on the tab where the work happens ───────────────────
  const w9Buttons = () => all('button').filter((b) => /View/.test(b.textContent || ''))
  say('W9: rows with a form offer to open it ->', w9Buttons().length >= 3, `(${w9Buttons().length})`)
  const noneRow = rows().find((x) => x.includes('No W9 Vendor'))
  say('W9: the vendor with no form still says NO ->', /NO/.test(noneRow || ''))
  const unresolved = rows().find((x) => x.includes('Unresolved W9'))
  say('W9: on-file-but-unresolved offers nothing to open ->',
    !!unresolved && !/View/.test(unresolved), unresolved ? '(row present)' : '(row missing)')
  const before = fetched.length
  const w9btn = w9Buttons()[0]
  if (w9btn) click(w9btn)
  await sleep(600)
  const asked = fetched.slice(before).find((u) => /file\/w9/.test(u)) || ''
  say('W9: clicking it fetches a document ->', !!asked, asked.split('?')[0] || '(nothing fetched)')
  say('W9: from the entry that HOLDS the form, not the vendor row ->',
    /\/bk\/entries\/4321\/file\/w9/.test(asked), asked.split('?')[0])
  say('W9: with a token, so the file actually serves ->', /token=/.test(asked))
  say('W9: and the modal names the file ->', /w9-ready-vendor\.pdf/.test(text()))
  const closer = all('button[title="Close"], button').find((b) => /Close/.test(b.getAttribute('title') || ''))
  if (closer) click(closer)
  await sleep(250)
  const scan = all('button').find((b) => /Read the W-9s/.test(b.textContent || ''))
  say('SCAN: the button is there ->', !!scan)
  if (scan) click(scan)
  await sleep(2500)
  const scans = calls.post.filter((c) => /scan-w9-tax/.test(c.url)).length
  say('SCAN: it looped until nothing was left ->', scans === 2, `(${scans} calls for 14 vendors at 10 a batch)`)
  say('SCAN: and reloaded the run afterwards ->',
    calls.get.filter((c) => c.url.startsWith('/bk/1099')).length >= 2)

  console.error = origError
  say('rendered bytes:', document.getElementById('root').innerHTML.length)
  if (errors.length) { say('--- errors ---'); for (const e of [...new Set(errors)].slice(0, 8)) say(e) }
  else say('no errors captured')
  globalThis.__DONE__ = true
})()
