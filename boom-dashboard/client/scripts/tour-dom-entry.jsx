// Does the tour engine drive? A fake page with the anchors the welcome and
// Home tours point at, the provider around it. fresh: NOTHING auto-starts; the walk is started by hand,
// Next walks the steps that are on screen, Done PUTs completion. done:
// welcome is done and Home was finished at an OLD version → the Home tour
// reads as updated but does NOT auto-start (a tour runs itself once, ever).
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route, useLocation, Link, useNavigate } from 'react-router-dom'
import { TourProvider, useTour } from '../src/components/Tour'
import { calls } from './tour-api-stub.js'
import { TOURS, tourForPath } from '../src/tours'

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
globalThis.__HOME_ROLE__ = scenario === 'user' ? 'User' : 'Superadmin'
if (scenario === 'mobile') window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} })
const prepared = []
window.addEventListener('tour:prepare', (e) => prepared.push(`${e.detail.prepare}:${e.detail.active ? 'on' : 'off'}`))
window.__TOUR_WAIT_MS__ = 600
// jsdom has no layout: give the anchors a size so `visible()` is true
const origRect = window.HTMLElement.prototype.getBoundingClientRect
window.HTMLElement.prototype.getBoundingClientRect = function () { if (this.hasAttribute && this.hasAttribute('data-hidden')) return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }; if (this.getAttributeNames && (this.getAttributeNames().some((n) => n.startsWith('data-')) || (this.parentElement && this.parentElement.getAttributeNames ? this.parentElement.getAttributeNames() : []).some((n) => n.startsWith('data-')))) return { top: 100, left: 100, width: 200, height: 40, right: 300, bottom: 140 }; if (this.hasAttribute && (this.hasAttribute('data-tour') || this.hasAttribute('data-quick-actions') || this.hasAttribute('data-week') || this.hasAttribute('data-activity') || this.hasAttribute('data-brand-drop') || this.hasAttribute('data-brand-filter') || this.hasAttribute('data-directory') || this.hasAttribute('data-invite') || this.hasAttribute('data-legend') || (this.tagName === 'ASIDE' && this.closest('[data-settings-shell]')))) return { top: 100, left: 100, width: 200, height: 40, right: 300, bottom: 140 }; return origRect.call(this) }

// One fake page per route, rendering the anchors the tours point at ON THAT
// ROUTE — derived from the tours themselves, so a new tour needs no edit here.
// The first alternative of each target is rendered as an element carrying its
// data attributes (and a descendant tag when the selector names one).
const parseSel = (sel) => {
  const m = /^((?:\[data-[a-z0-9-]+(?:="[^"]*")?\])+)(?:\s+([a-z]+))?$/.exec(sel.trim()); if (!m) return null
  const attrs = {}; for (const a of m[1].matchAll(/\[(data-[a-z0-9-]+)(?:="([^"]*)")?\]/g)) attrs[a[1]] = a[2] ?? ''
  return { attrs, child: m[2] || null }
}
const anchorsFor = (pathname) => {
  const out = new Map()
  for (const t of TOURS) {
    // page-aware, like the engine: /messages/general carries the Messages anchors
    const on = t.match ? t.match.test(pathname) : (t.path === pathname || tourForPath(pathname)?.id === t.id)
    for (const st of t.steps) {
      const p = st.path || t.path
      if ((t.multipage ? (p === pathname || tourForPath(pathname)?.path === p) : on) && st.target) { const parsed = parseSel(String(st.target).split(',')[0]); if (parsed) out.set(JSON.stringify(parsed), parsed) }
    }
  }
  return [...out.values()]
}
function Page() {
  const { pageTour, tours, startTour } = useTour()
  window.__START__ = startTour
  const loc = useLocation()
  const navigate = useNavigate()
  // The real Messages page redirects /messages to the most recent channel the
  // moment it loads. The walk used to wait 4 s there and skip the page.
  React.useEffect(() => { if (loc.pathname === '/messages') navigate('/messages/general', { replace: true }) }, [loc.pathname, navigate])
  const anchors = anchorsFor(loc.pathname)
  return (
    <div>
      <p data-where>{loc.pathname}</p>
      {anchors.filter((a) => !(scenario === 'fresh' && a.attrs['data-tour'] === 'my-work-week')).map((a, i) => {   // fresh: one anchor deliberately missing
        // on a phone the desktop help button is hidden; the walkthrough icon stands in
        const hidden = scenario === 'mobile' && a.attrs['data-tour'] === 'help'
        const props = { ...a.attrs, ...(hidden ? { 'data-hidden': '' } : {}) }
        // a table needs a row to hold text, or React warns about DOM nesting
        const child = a.child === 'table' ? <table><tbody><tr><td>table</td></tr></tbody></table> : a.child ? <a.child>{a.child}</a.child> : null
        return <div key={i} {...props}>{child || Object.values(a.attrs).join(' ') || 'anchor'}</div>
      })}
      {scenario === 'mobile' && loc.pathname === '/' && <div data-tour="walkthrough">icon</div>}
      <p data-page-tour>{pageTour?.id || 'none'} · {tours.length} tours</p>
      <Link to="/releases" data-away>away</Link>
    </div>
  )
}
async function main() {
  say(`SCENARIO ${scenario}`)
  const host = document.createElement('div'); document.body.appendChild(host)
  createRoot(host).render(<MemoryRouter initialEntries={[scenario === 'user' ? '/team' : scenario === 'detail' ? '/team/1' : '/']}><TourProvider><Routes><Route path="*" element={<Page />} /></Routes></TourProvider></MemoryRouter>)
  // Nothing starts on its own any more: wait long enough for the old auto-start timers to have fired, then assert silence.
  await sleep(1400)
  const ov = () => document.querySelector('[data-tour-overlay]')
  assert('nothing threw', errors.length === 0); if (errors.length) say('  ' + errors.join('\n  '))
  if (scenario === 'fresh') {
    const card = () => ov()?.querySelector('[data-tour-card]')
    const where = () => textOf(host.querySelector('[data-where]'))
    const total = TOURS.find((t) => t.id === 'welcome').steps.length
    assert('NOTHING auto-starts on first sign-in — walkthroughs are optional', !ov())
    window.__START__('welcome'); await sleep(400)
    assert('the welcome walk starts from the Walkthrough button', ov()?.getAttribute('data-tour-id') === 'welcome')
    assert('it opens with a centered card, no spotlight, that says skipping is allowed', !ov().querySelector('[data-tour-spotlight]') && /Skip a page, a family, or the whole tour/.test(textOf(card())))
    assert(`the count covers every visible page plus the family strips (${total})`, new RegExp(`1 of ${total}`).test(textOf(card())))
    assert('Skip tour and Skip this page are both offered', !!card().querySelector('[data-tour-skip-all]') && !!card().querySelector('[data-tour-skip-page]'))
    click(card().querySelector('[data-tour-next]')); await sleep(300)
    assert('step 2 spotlights the sidebar on Home', /Everything is in the sidebar/.test(textOf(card())) && !!ov().querySelector('[data-tour-spotlight]') && where() === '/')
    card().querySelector('[data-tour-next]').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(200)
    assert('Enter on the focused Next button is left to the click — it does not advance a second time', /Everything is in the sidebar/.test(textOf(card())))
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); await sleep(200)
    assert('ArrowRight on the page advances one step', /Search jumps anywhere/.test(textOf(card())))
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); await sleep(200)
    assert('ArrowLeft goes back one', /Everything is in the sidebar/.test(textOf(card())))
    // Focus stays on Next after a click; the arrows must still work from there.
    card().querySelector('[data-tour-next]').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); await sleep(200)
    assert('ArrowRight with the Next BUTTON focused still advances (only Enter is left to the click)', /Search jumps anywhere/.test(textOf(card())))
    card().querySelector('[data-tour-back]')?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); await sleep(200)
    assert('ArrowLeft with a tour button focused goes back', /Everything is in the sidebar/.test(textOf(card())))
    click(card().querySelector('[data-tour-skip-page]')); await sleep(600)
    assert('Skip this page jumps to the next page in sidebar order: My Work, its orientation step', where() === '/my-work' && /· My Work/.test(textOf(card())) && !!ov().querySelector('[data-tour-spotlight]'))
    assert('the counter says where this step sits within its page', /My Work 1 of 5/.test(textOf(card().querySelector('[data-tour-counter]'))))
    click(card().querySelector('[data-tour-next]')); await sleep(400)
    assert('Next STAYS on My Work for its second step — the page is walked in full', where() === '/my-work' && /Your list, by when/.test(textOf(card())) && /My Work 2 of 5/.test(textOf(card().querySelector('[data-tour-counter]'))))
    click(card().querySelector('[data-tour-next]')); await sleep(1100)
    assert('a step whose anchor never renders (no data) is SHOWN centered, not skipped', where() === '/my-work' && /This week, mine/.test(textOf(card())) && ov().getAttribute('data-tour-anchor-missing') === '1' && !!card().querySelector('[data-tour-missing]') && !ov().querySelector('[data-tour-spotlight]'))
    click(card().querySelector('[data-tour-next]')); await sleep(400)
    assert('…and Next moves to the fourth step, still on My Work', where() === '/my-work' && /Waiting on you/.test(textOf(card())))
    click(card().querySelector('[data-tour-next]')); await sleep(400)
    assert('the last step of every page with keys is "Keys on this page", built from lib/shortcuts', where() === '/my-work' && /Keys on this page/.test(textOf(card())) && /N new task/i.test(textOf(card())))
    click(card().querySelector('[data-tour-next]')); await sleep(600)
    assert('after the last step of My Work the walk moves to the NEXT PAGE — Messages, which redirected to a channel, and its first step SHOWS there with its anchor', where() === '/messages/general' && /Messages 1 of/.test(textOf(card().querySelector('[data-tour-counter]'))) && !!ov().querySelector('[data-tour-spotlight]') && !/Opening/.test(textOf(card())))
    click(card().querySelector('[data-tour-back]')); await sleep(600)
    assert('Back returns to My Work', where() === '/my-work')
    // walk until a family strip step appears, then Skip that family
    let guard = 0
    while (ov() && guard < 100 && !card().querySelector('[data-tour-skip-family]')) { const b = card().querySelector('[data-tour-next]'); if (b && !b.disabled) click(b); await sleep(350); guard += 1 }
    const famLabel = card()?.querySelector('[data-tour-skip-family]')?.textContent || ''
    const famPath = where()
    assert('a family step offers Skip <family> on its tab strip, with the tab names', /Skip Releases/.test(famLabel) && /Pipeline · Catalog/.test(textOf(card())) && famPath === '/releases')
    click(card().querySelector('[data-tour-skip-family]')); await sleep(700)
    assert('Skip this family lands on the next family\'s tab-strip step (Contracts, on Deals)', where() === '/deals' && /Contracts: 4 tabs/.test(textOf(card())) && /Deals · Active · Pending · Renewals/.test(textOf(card())))
    // walk the rest
    guard = 0
    while (ov() && guard < 400) { const b = card().querySelector('[data-tour-next]'); if (b && !b.disabled) click(b); await sleep(350); guard += 1 }
    assert('the tour ends back on Home after visiting every page', !ov() && where() === '/')
    const put = calls.put.filter((c) => c.url === '/settings/me/tours').pop()
    const batch = put?.body?.tours || (put?.body ? [put.body] : [])
    assert('…and records welcome PLUS every page tour the walk ran, so none replays on its own', !!put && batch.some((b) => b.id === 'welcome' && b.skipped === false) && batch.some((b) => b.id === 'my-work') && batch.length > 2)
    assert('…but NOT the page that was skipped with Skip this page (Home keeps its first-open tour)', !batch.some((b) => b.id === 'home'))
    await sleep(1200)
    assert('…but Home\'s tour does not pounce the moment the walk ends', !ov())
  } else if (scenario === 'mobile') {
    const card = () => ov()?.querySelector('[data-tour-card]')
    assert('on a phone nothing auto-starts either', !ov())
    window.__START__('welcome'); await sleep(400)
    assert('the welcome walk starts from the footprints icon', ov()?.getAttribute('data-tour-id') === 'welcome')
    assert('the card is a bottom sheet, not a floating box', card()?.getAttribute('data-tour-sheet') === '1' && !card().style.top)
    click(card().querySelector('[data-tour-next]')); await sleep(500)
    assert('the sidebar step asks Layout to open the drawer', /Everything is in the sidebar/.test(textOf(card())) && prepared.includes('sidebar:on'))
    assert('…and spotlights the sidebar once the drawer has slid in', !!ov().querySelector('[data-tour-spotlight]'))
    click(card().querySelector('[data-tour-next]')); await sleep(300)
    assert('moving on closes the drawer again', prepared[prepared.length - 1] === 'sidebar:off' && /Search jumps anywhere/.test(textOf(card())))
    let guard = 0
    while (ov() && guard < 400) {
      const isLast = /Done/.test(textOf(card().querySelector('[data-tour-next]')))
      if (isLast) break
      const b = card().querySelector('[data-tour-next]'); if (b && !b.disabled) click(b); await sleep(450); guard += 1
    }
    assert('the last step skips the HIDDEN desktop help button and spotlights the walkthrough icon instead', ov() && /That is the dashboard/.test(textOf(card())) && !!ov().querySelector('[data-tour-spotlight]') && ov().getAttribute('data-tour-waiting') === '0')
    click(card().querySelector('[data-tour-next]')); await sleep(300)
    assert('Done closes it', !ov())
  } else if (scenario === 'detail') {
    // A detail page (a person's page) with welcome SKIPPED long ago at an old version.
    assert('a detail page opens quietly — no tour pounces', !ov())
    window.__START__('team-member'); await sleep(400)
    assert('its tour starts by hand', ov()?.getAttribute('data-tour-id') === 'team-member')
    assert('the detail tour is the page tour the header offers', /team-member · \d+ tours/.test(textOf(host.querySelector('[data-page-tour]'))))
    const steps = TOURS.find((t) => t.id === 'team-member').steps.length
    for (let i = 0; i < steps; i += 1) { click(ov().querySelector('[data-tour-next]')); await sleep(200) }
    const put = calls.put.find((c) => c.url === '/settings/me/tours')
    assert('Done records the detail tour by id, not its parent nav page', !ov() && !!put && put.body.id === 'team-member' && put.body.skipped === false)
    click(host.querySelector('[data-away]')); await sleep(400)
    assert('leaving for another page does not start anything else (its tour was recorded)', !ov())
  } else if (scenario === 'user') {
    assert('a User on People: the People tour (admin views) does not auto-start', !ov())
    assert('the page reports no tour for it, and the list omits People', /^none · \d+ tours/.test(textOf(host.querySelector('[data-page-tour]'))) && !document.body.textContent.includes('people ·'))
    const wsteps = TOURS.find((t) => t.id === 'welcome').steps
    const total = wsteps.length
    const adminOnly = wsteps.filter((st) => st.roles && !st.roles.includes('User')).length
    window.__START__('welcome'); await sleep(900)
    assert(`the welcome walk for a User drops the ${adminOnly} admin-only steps (${total - adminOnly} of ${total})`, adminOnly >= 1 && ov()?.getAttribute('data-tour-id') === 'welcome' && new RegExp(`1 of ${total - adminOnly}`).test(textOf(ov().querySelector('[data-tour-card]'))))
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })); await sleep(300)
  } else {
    assert('with welcome done and Home at an OLD version, NOTHING auto-starts', !ov())
    assert('the page knows its tour and the list of tours the user can open', /home · \d+ tours/.test(textOf(host.querySelector('[data-page-tour]'))))
    window.__START__('home'); await sleep(500)
    assert('the updated Home tour can still be started by hand', ov()?.getAttribute('data-tour-id') === 'home')
    // Leave the page mid-tour (a sidebar click, a g-chord): the single-page tour closes and records nothing.
    const putsBefore = calls.put.length
    click(host.querySelector('[data-away]')); await sleep(400)
    assert('leaving the page closes a single-page tour instead of leaving it floating over the wrong page', !ov() && textOf(host.querySelector('[data-where]')) === '/releases')
    assert('…and records nothing', calls.put.length === putsBefore)
    window.__START__('releases'); await sleep(400)
    assert('a tour started on its own page stays up', ov()?.getAttribute('data-tour-id') === 'releases')
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })); await sleep(300)
    assert('Escape closes it', !ov())
  }
  say('DONE'); globalThis.__DONE__ = true
}
main()
