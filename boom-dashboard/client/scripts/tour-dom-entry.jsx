// Does the tour engine drive? A fake page with the anchors the welcome and
// Home tours point at, the provider around it. fresh: welcome auto-starts,
// Next walks the steps that are on screen, Done PUTs completion. done:
// welcome is done and Home was finished at an OLD version → the Home tour
// offers itself as updated and auto-starts on '/'.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import { TourProvider, useTour } from '../src/components/Tour'
import { calls } from './tour-api-stub.js'

const errors = []
window.addEventListener('error', (e) => errors.push('window.error: ' + e.message))
console.error = (...a) => { errors.push('console.error: ' + a.map(String).join(' ').slice(0, 300)) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const say = (...a) => console.log(...a)
const assert = (label, cond) => say(`  ${label} -> ${!!cond}`)
const textOf = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '')
const click = (el) => el && el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
const scenario = (typeof process !== 'undefined' && process.env.TOUR_SCENARIO) || 'fresh'
globalThis.__TOUR_SCENARIO__ = scenario
window.__TOUR_WAIT_MS__ = 600
// jsdom has no layout: give the anchors a size so `visible()` is true
const origRect = window.HTMLElement.prototype.getBoundingClientRect
window.HTMLElement.prototype.getBoundingClientRect = function () { if (this.hasAttribute && (this.hasAttribute('data-tour') || this.hasAttribute('data-quick-actions') || this.hasAttribute('data-week') || this.hasAttribute('data-activity') || this.hasAttribute('data-brand-drop') || this.hasAttribute('data-directory') || (this.tagName === 'ASIDE' && this.closest('[data-settings-shell]')))) return { top: 100, left: 100, width: 200, height: 40, right: 300, bottom: 140 }; return origRect.call(this) }

// One fake page per route, each rendering the anchors its real page has —
// so the welcome tour can walk them under jsdom.
const ANCHORS = {
  '/': ['sidebar', 'home-loop', 'search', 'help'], '/my-work': ['my-work-list'], '/artists': ['artists-header'], '/releases': ['releases-list'],
  '/deals': ['deal-board'], '/contracts': ['contracts-header'], '/bk/approvals': ['approvals'], '/bk/payments': ['payments'], '/calendar': ['calendar-grid'],
}
function Page() {
  const { pageTour, tours } = useTour()
  const loc = useLocation()
  const names = ANCHORS[loc.pathname] || []
  return (
    <div>
      <p data-where>{loc.pathname}</p>
      {names.map((n) => <div key={n} data-tour={n}>{n}</div>)}
      {loc.pathname === '/' && <><div data-quick-actions>start</div><div data-week>week</div><div data-activity>activity</div></>}
      {loc.pathname === '/brand' && <div data-brand-drop>drop</div>}
      {loc.pathname === '/team' && <div data-directory>people</div>}
      {loc.pathname === '/settings' && <div data-settings-shell><aside>rail</aside></div>}
      <p data-page-tour>{pageTour?.id || 'none'} · {tours.length} tours</p>
    </div>
  )
}
async function main() {
  say(`SCENARIO ${scenario}`)
  const host = document.createElement('div'); document.body.appendChild(host)
  createRoot(host).render(<MemoryRouter initialEntries={['/']}><TourProvider><Routes><Route path="*" element={<Page />} /></Routes></TourProvider></MemoryRouter>)
  for (let i = 0; i < 40 && !document.querySelector('[data-tour-overlay]'); i += 1) await sleep(100)
  await sleep(150)
  const ov = () => document.querySelector('[data-tour-overlay]')
  assert('nothing threw', errors.length === 0); if (errors.length) say('  ' + errors.join('\n  '))
  if (scenario === 'fresh') {
    const card = () => ov()?.querySelector('[data-tour-card]')
    const where = () => textOf(host.querySelector('[data-where]'))
    assert('the welcome tour auto-starts on first sign-in', ov()?.getAttribute('data-tour-id') === 'welcome')
    assert('it opens with a centered card, no spotlight, that says skipping is allowed', !ov().querySelector('[data-tour-spotlight]') && /skip a page, or the whole tour/.test(textOf(card())))
    assert('the count covers every page a Superadmin can open (16 steps)', /1 of 16/.test(textOf(card())))
    assert('Skip tour and Skip this page are both offered', !!card().querySelector('[data-tour-skip-all]') && !!card().querySelector('[data-tour-skip-page]'))
    click(card().querySelector('[data-tour-next]')); await sleep(300)
    assert('step 2 spotlights the sidebar on Home', /Everything is in the sidebar/.test(textOf(card())) && !!ov().querySelector('[data-tour-spotlight]') && where() === '/')
    click(card().querySelector('[data-tour-skip-page]')); await sleep(600)
    assert('Skip this page jumps to the next page: My Work', where() === '/my-work' && /My Work/.test(textOf(card())) && /5 of 16 · my work/.test(textOf(card())))
    click(card().querySelector('[data-tour-next]')); await sleep(600)
    assert('Next navigates to Artists and spotlights its header', where() === '/artists' && !!ov().querySelector('[data-tour-spotlight]') && /Artists/.test(textOf(card())))
    click(card().querySelector('[data-tour-back]')); await sleep(600)
    assert('Back returns to My Work', where() === '/my-work')
    // walk the rest
    let guard = 0
    while (ov() && guard < 20) { const b = card().querySelector('[data-tour-next]'); if (b && !b.disabled) click(b); await sleep(650); guard += 1 }
    assert('the tour ends back on Home after visiting every page', !ov() && where() === '/')
    const put = calls.put.find((c) => c.url === '/settings/me/tours')
    assert('…and records completion with the version, not skipped', !!put && put.body.id === 'welcome' && put.body.version === '2026-09-19' && put.body.skipped === false)
    for (let i = 0; i < 20 && !ov(); i += 1) await sleep(100)
    assert('then the Home tour auto-starts, because this page has one and it is not done', ov()?.getAttribute('data-tour-id') === 'home')
    click(ov().querySelector('[data-tour-skip-all]')); await sleep(300)
    const skip = calls.put.filter((c) => c.url === '/settings/me/tours').pop()
    assert('Skip tour records the tour as skipped at its version', !ov() && skip.body.id === 'home' && skip.body.skipped === true)
  } else {
    assert('with welcome done and Home at an OLD version, Home auto-starts as updated', ov()?.getAttribute('data-tour-id') === 'home')
    assert('the page knows its tour and the list of tours the user can open', /home · \d+ tours/.test(textOf(host.querySelector('[data-page-tour]'))))
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })); await sleep(300)
    assert('Escape closes it', !ov())
  }
  say('DONE'); globalThis.__DONE__ = true
}
main()
