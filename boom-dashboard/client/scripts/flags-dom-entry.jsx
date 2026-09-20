// Does the Flags page draw the register, and only for who may see it?
//
// `npm run smoke` renders this page under `renderToString`, where effects never
// fire, so it only ever draws its loading skeleton — every category is behind
// GET /flags. This mounts it for real (scripts/flags-api-stub.js).
//
// What can go wrong without throwing:
//   the rail lists 23 zeros and buries the three rows that matter
//   "new" is computed against the seen-at the page just stamped, so it vanishes
//   a capped list reads as complete
//   a register row's verbs post the wrong shape, or to the wrong endpoint
//   a check that failed reads as clear
//   a User sees a category whose page they cannot open
//
// Scenarios: admin · section · empty · user (FLAGS_SCENARIO env).
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import Duplicates from '../src/pages/Duplicates'
import { calls } from './flags-api-stub.js'
import { ThemeProvider } from '../src/context/ThemeContext'
import { ToastProvider } from '../src/context/ToastContext'

const errors = []
window.addEventListener('error', (e) => errors.push('window.error: ' + e.message))
console.error = (...a) => { errors.push('console.error: ' + a.map(String).join(' ').slice(0, 300)) }
window.alert = (m) => errors.push('alert: ' + m)

class Catch extends React.Component {
  constructor(p) { super(p); this.state = { err: null } }
  static getDerivedStateFromError(err) { return { err } }
  componentDidCatch(err) { errors.push('THROWN: ' + (err && err.message)) }
  render() { return this.state.err ? null : this.props.children }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const say = (...a) => console.log(...a)
const assert = (label, cond) => say(`  ${label} -> ${!!cond}`)
const textOf = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '')
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
const setValue = (el, v) => { const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set; setter.call(el, v); el.dispatchEvent(new window.Event('change', { bubbles: true })) }

const scenario = (typeof process !== 'undefined' && process.env.FLAGS_SCENARIO) || 'admin'
globalThis.__FLAGS_SCENARIO__ = scenario
const START = scenario === 'section' ? '/flags?tab=approval_stale&focus=108' : '/flags'

async function main() {
  say(`SCENARIO ${scenario}`)
  const host = document.createElement('div')
  document.body.appendChild(host)
  createRoot(host).render(
    <Catch><ThemeProvider><ToastProvider>
      <MemoryRouter initialEntries={[START]}><Duplicates /></MemoryRouter>
    </ToastProvider></ThemeProvider></Catch>
  )
  for (let i = 0; i < 50 && !host.querySelector('[data-tour="flags-overview"], [data-register-section], [data-flags-meta]'); i += 1) await sleep(100)
  await sleep(300)
  if (errors.length) for (const e of errors) say('    EARLY ' + e)
  const html = textOf(host)
  const nav = host.querySelector('[data-tour="flags-nav"]')

  if (scenario === 'admin') {
    assert('the page stamped "seen" exactly once, AFTER the first load', calls.post.filter((c) => c.url === '/flags/seen').length === 1)
    assert('header counts what is new since the viewer last looked (2 register rows + 1 duplicate group first seen today)', /3 new since you last looked/.test(html))
    const meta = host.querySelector('[data-flags-meta]')
    assert('the meta line says when the sweep ran and that it is hourly', !!meta && /Checked 12 min ago/.test(textOf(meta)) && /every hour/.test(textOf(meta)))
    assert('a check that could not run is NAMED, not silently clear', !!host.querySelector('[data-flags-sweep-errors]') && /attachment_missing/.test(textOf(meta)))
    const navButtons = [...nav.querySelectorAll('button')].map(textOf)
    assert('the rail lists only categories with something in them (no zero rows)', !navButtons.some((t) => /\b0$/.test(t)) && navButtons.some((t) => /Label record incomplete/.test(t)))
    assert('…and says how many checks in a group are clear', [...nav.querySelectorAll('[data-nav-clear]')].some((el) => /1 check clear/.test(textOf(el))))
    assert('Setup leads the rail, then Money, Workflow, Compliance, Ledger', (() => { const groups = [...nav.querySelectorAll('p.uppercase')].map(textOf); return groups[0] === 'Setup' && groups.indexOf('Workflow') > groups.indexOf('Money') && groups.indexOf('Ledger') > groups.indexOf('Compliance') })())
    assert('a new-dot marks the rail row of a category with something new', nav.querySelectorAll('[data-nav-new]').length >= 1)
    const cards = [...host.querySelectorAll('button.card')].filter((b) => /Approvals waiting too long/.test(textOf(b)))
    assert('an overview card carries its group tag, the new badge and the oldest age', cards.length === 1 && /Workflow/.test(textOf(cards[0])) && /1 new/.test(textOf(cards[0])) && /oldest 4 days/.test(textOf(cards[0])))
    const ownerCard = [...host.querySelectorAll('button')].find((b) => /Ledger — Unknown Artist/.test(textOf(b)) && /→/.test(textOf(b)))
    assert('a category with an owner shows who holds it on its card', !!ownerCard && /→ Sam Chen/.test(textOf(ownerCard)))
    assert('the refresh control offers "Check now" to an admin', /Check now/.test(textOf(host.querySelector('[data-flags-refresh]'))))
    click(host.querySelector('[data-flags-refresh]'))
    await sleep(300)
    assert('Check now runs the sweep, then reloads', calls.post.some((c) => c.url === '/flags/sweep') && calls.get.filter((u) => u === '/flags' || u.startsWith('/flags?')).length >= 2)
  }

  if (scenario === 'section') {
    const sec = host.querySelector('[data-register-section="approval_stale"]')
    assert('the register section renders one row per flag (the dismissed one hidden by default)', !!sec && sec.querySelectorAll('[data-flag-row]').length === 2)
    const focus = sec.querySelector('[data-flag-row="108"]')
    assert('the focused row (from ?focus=) is present, marked NEW, shows money and links to the page that resolves it', !!focus && !!focus.querySelector('[data-flag-new-pill]') && /\$1,500/.test(textOf(focus)) && focus.querySelector('[data-flag-open]')?.getAttribute('href') === '/bk/approvals')
    const owned = sec.querySelector('[data-flag-row="109"]')
    assert('an assigned row shows its owner and is not new', !!owned && /Sam Chen/.test(textOf(owned.querySelector('[data-flag-owner]'))) && !owned.querySelector('[data-flag-new-pill]') && /4 days/.test(textOf(owned)))
    assert('the section header says how many are new and the oldest age', /1 new/.test(textOf(host.querySelector('[data-section-new]'))) && /oldest 4 days/.test(textOf(host.querySelector('[data-section-oldest]'))))
    // assign
    click(focus.querySelector('[data-flag-assign]'))
    await sleep(50)
    const pop = focus.querySelector('[data-flag-assign-popover]')
    assert('Assign opens a picker of the team', !!pop && pop.querySelectorAll('option').length === 4)
    setValue(pop.querySelector('[data-flag-assignee]'), '2')
    await sleep(20)
    click(pop.querySelector('[data-flag-assign-submit]'))
    await sleep(200)
    const as = calls.post.find((c) => c.url === '/flags/assign')
    assert('…and posts kind, key, user_id, title, to and severity — the shape the task is built from', !!as && as.body.kind === 'approval_stale' && as.body.key === '108' && as.body.user_id === 2 && /Northgate/.test(as.body.title) && as.body.to === '/bk/approvals' && as.body.severity === 'high')
    // dismiss + snooze
    click(sec.querySelector('[data-flag-row="108"] [data-flag-dismiss]'))
    await sleep(150)
    const dm = calls.post.find((c) => c.url === '/flags/register/dismiss' && c.body.key === '108')
    assert('Dismiss posts kind + key with undo false and no date', !!dm && dm.body.kind === 'approval_stale' && dm.body.undo === false && dm.body.until === undefined)
    const row109 = host.querySelector('[data-flag-row="109"]')
    click(row109.querySelector('[data-flag-snooze]'))
    await sleep(30)
    click(row109.querySelector('[data-flag-snooze-days="7"]'))
    await sleep(150)
    const sn = calls.post.find((c) => c.url === '/flags/register/dismiss' && c.body.key === '109')
    assert('Snooze posts an ISO day a week out', !!sn && /^\d{4}-\d{2}-\d{2}$/.test(sn.body.until) && (new Date(sn.body.until) - Date.now()) > 5 * 86400000)
    assert('every register verb refetched the page (rows leave because the server says so)', calls.get.filter((u) => u === '/flags' || u.startsWith('/flags?')).length >= 4)
    assert('nothing threw and no alert fired', errors.length === 0)
  }

  if (scenario === 'empty') {
    const clear = host.querySelector('[data-flags-all-clear]')
    assert('nothing flagged → the all-clear card', !!clear && /Nothing flagged right now/.test(textOf(clear)))
    assert('…which lists every group with its count of checks and what fills it', /Setup ?2 checks/.test(textOf(clear)) && /Workflow ?2 checks/.test(textOf(clear)) && /Compliance ?1 check/.test(textOf(clear)) && /the label record, mail, integrations/.test(textOf(clear)))
    assert('…and says when every check last ran', /ran 12 min ago/.test(textOf(clear)))
    assert('the rail has no category rows, only "checks clear" lines', nav.querySelectorAll('button').length === 1 && nav.querySelectorAll('[data-nav-clear]').length >= 4)
    assert('the header reads Nothing flagged', /Nothing flagged\./.test(html))
  }

  if (scenario === 'user') {
    const kinds = [...nav.querySelectorAll('button')].map(textOf)
    assert('a /releases-only User sees the release kinds and nothing money- or settings-shaped', kinds.some((t) => /Releases with nobody/.test(t)) && !kinds.some((t) => /Label|Approvals|W-9|statement/i.test(t)))
    assert('no "Check now" for a User (the sweep is admin-only)', !/Check now/.test(textOf(host.querySelector('[data-flags-refresh]'))))
    assert('a viewer who never looked before sees everything as new', /1 new since you last looked/.test(html))
    // A register category's section header must NOT offer the category-level Assign (that is for data-quality bulk work)…
    // …but the row does. Open the section.
    const btn = [...nav.querySelectorAll('button')].find((b) => /Releases with nobody/.test(textOf(b)))
    click(btn); await sleep(200)
    assert('opening the section renders the register rows with Open → /releases', host.querySelector('[data-register-section="release_unassigned"] [data-flag-open]')?.getAttribute('href') === '/releases')
  }

  assert('no errors during render', errors.length === 0)
  if (errors.length) for (const e of errors) say('    ' + e)
  say('DONE')
}
main()
