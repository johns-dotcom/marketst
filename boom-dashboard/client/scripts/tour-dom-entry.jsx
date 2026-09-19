// Does the tour engine drive? A fake page with the anchors the welcome and
// Home tours point at, the provider around it. fresh: welcome auto-starts,
// Next walks the steps that are on screen, Done PUTs completion. done:
// welcome is done and Home was finished at an OLD version → the Home tour
// offers itself as updated and auto-starts on '/'.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
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
// jsdom has no layout: give the anchors a size so `visible()` is true
const origRect = window.HTMLElement.prototype.getBoundingClientRect
window.HTMLElement.prototype.getBoundingClientRect = function () { if (this.hasAttribute && (this.hasAttribute('data-tour') || this.hasAttribute('data-quick-actions') || this.hasAttribute('data-week') || this.hasAttribute('data-activity'))) return { top: 100, left: 100, width: 200, height: 40, right: 300, bottom: 140 }; return origRect.call(this) }

function Page() {
  const { pageTour, tours } = useTour()
  return (
    <div>
      <nav data-tour="sidebar">nav</nav>
      <div data-tour="home-loop">loop</div>
      <span data-tour="search">search</span>
      <span data-tour="help">help</span>
      <div data-quick-actions>start</div>
      <div data-week>week</div>
      <div data-activity>activity</div>
      <p data-page-tour>{pageTour?.id || 'none'} · {tours.length} tours</p>
    </div>
  )
}
async function main() {
  say(`SCENARIO ${scenario}`)
  const host = document.createElement('div'); document.body.appendChild(host)
  createRoot(host).render(<MemoryRouter initialEntries={['/']}><TourProvider><Page /></TourProvider></MemoryRouter>)
  for (let i = 0; i < 40 && !document.querySelector('[data-tour-overlay]'); i += 1) await sleep(100)
  await sleep(150)
  const ov = () => document.querySelector('[data-tour-overlay]')
  assert('nothing threw', errors.length === 0); if (errors.length) say('  ' + errors.join('\n  '))
  if (scenario === 'fresh') {
    assert('the welcome tour auto-starts on first sign-in', ov()?.getAttribute('data-tour-id') === 'welcome')
    assert('a spotlight and a card render', !!ov().querySelector('[data-tour-spotlight]') && /Everything is in the sidebar/.test(textOf(ov().querySelector('[data-tour-card]'))))
    assert('the card counts only steps whose anchors are on screen (4 of 6 here)', /1 of 4/.test(textOf(ov().querySelector('[data-tour-card]'))))
    click(ov().querySelector('[data-tour-next]')); await sleep(400)
    assert('Next moves to the loop step, skipping nothing that is present', /Home is what needs doing/.test(textOf(ov().querySelector('[data-tour-card]'))) && /2 of 4/.test(textOf(ov())))
    click(ov().querySelector('[data-tour-back]')); await sleep(300)
    assert('Back returns', /1 of 4/.test(textOf(ov())))
    for (let i = 0; i < 4 && ov(); i += 1) { click(ov().querySelector('[data-tour-next]')); await sleep(350) }
    assert('Done closes the tour', !ov())
    const put = calls.put.find((c) => c.url === '/settings/me/tours')
    assert('…and records completion with the version, not skipped', !!put && put.body.id === 'welcome' && put.body.version === '2026-09-19' && put.body.skipped === false)
    for (let i = 0; i < 20 && !ov(); i += 1) await sleep(100)
    assert('then the Home tour auto-starts, because this page has one and it is not done', ov()?.getAttribute('data-tour-id') === 'home')
    click(ov().querySelector('[data-tour-skip]')); await sleep(300)
    const skip = calls.put.filter((c) => c.url === '/settings/me/tours').pop()
    assert('Skip records the tour as skipped at its version', !ov() && skip.body.id === 'home' && skip.body.skipped === true)
  } else {
    assert('with welcome done and Home at an OLD version, Home auto-starts as updated', ov()?.getAttribute('data-tour-id') === 'home')
    assert('the page knows its tour and the list of tours the user can open', /home · \d+ tours/.test(textOf(host.querySelector('[data-page-tour]'))))
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })); await sleep(300)
    assert('Escape closes it', !ov())
  }
  say('DONE'); globalThis.__DONE__ = true
}
main()
