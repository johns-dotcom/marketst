// Is the calendar the team's calendar?
//
// Every typed event renders in the month grid; the legend is the filter and
// carries counts; a source withheld by permission is named as such; each
// event in the day panel links to the page it came from; an empty calendar
// says what fills it. All of it lives past the loading return, so smoke never
// reaches it.
//
// Scenarios (CAL_SCENARIO env): full · gated · empty
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Calendar from '../src/pages/Calendar'
import { EVENTS } from './calendar-api-stub.js'
import { ThemeProvider } from '../src/context/ThemeContext'
import { ToastProvider } from '../src/context/ToastContext'

const errors = []
window.addEventListener('error', (e) => errors.push('window.error: ' + e.message))
console.error = (...a) => { errors.push('console.error: ' + a.map(String).join(' ').slice(0, 300)) }
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
const click = (el) => el && el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
const scenario = (typeof process !== 'undefined' && process.env.CAL_SCENARIO) || 'full'
globalThis.__CAL_SCENARIO__ = scenario

async function main() {
  say(`SCENARIO ${scenario}`)
  const host = document.createElement('div'); document.body.appendChild(host)
  createRoot(host).render(
    <Catch><ThemeProvider><ToastProvider>
      <MemoryRouter initialEntries={['/calendar']}><Routes><Route path="/calendar" element={<Calendar />} /></Routes></MemoryRouter>
    </ToastProvider></ThemeProvider></Catch>
  )
  for (let i = 0; i < 50 && !host.querySelector('[data-legend]'); i += 1) await sleep(100)
  await sleep(100)
  assert('the page rendered without throwing', errors.length === 0 && !!host.querySelector('[data-legend]'))
  if (errors.length) say('  ' + errors.join('\n  '))
  const legend = host.querySelector('[data-legend]')
  const row = (k) => legend.querySelector(`[data-legend-row="${k}"]`)
  const count = (k) => Number(textOf(row(k)?.querySelector('[data-legend-count]')))
  const grid = () => textOf(host.querySelector('.xl\\:col-span-3') || host)
  const headerCount = () => textOf(host.querySelector('[data-event-count]'))

  if (scenario === 'empty') {
    const es = host.querySelector('[data-empty-state]')
    assert('an empty calendar says what fills it', !!es && /Nothing on the calendar yet/.test(textOf(es)) && /payment due dates/.test(textOf(es)))
    assert('with an action and a source link', !!es && /Add an event/.test(textOf(es)) && !!es.querySelector('a[href="/releases"]'))
    assert('the legend still renders, every count 0', ['release', 'deadline', 'payment', 'renewal'].every((k) => count(k) === 0))
    say('DONE'); globalThis.__DONE__ = true; return
  }

  say('\nTHE FEED IN THE GRID')
  assert('the release, the task and the DSP go-live share a day in the grid', /Night Drive/.test(grid()) && /Send the artwork/.test(grid()) && /live on Spotify/.test(grid()))
  assert('the header counts everything loaded', new RegExp(`^${scenario === 'gated' ? 6 : 8} events`).test(headerCount()))

  say('\nTHE LEGEND IS THE FILTER')
  if (scenario === 'full') {
    assert('counts: 1 release · 2 tasks · 1 payment · 1 renewal · 1 signed · 1 DSP · 1 event',
      count('release') === 1 && count('deadline') === 2 && count('payment') === 1 && count('renewal') === 1 && count('contract') === 1 && count('dsp') === 1 && count('manual') === 1)
    assert('the payment due renders in the grid with its amount', /Northgate Studios — \$1,500 due/.test(grid()))
    assert('the renewal reads as an expiry', /Recording expires/.test(grid()))
    click(row('payment'))
    await sleep(100)
    assert('clicking Payments due hides the payment', !/Northgate Studios/.test(grid()) && /1 hidden by the legend/.test(headerCount()))
    assert('the row still says 1 — the count is what it WOULD show', count('payment') === 1 && row('payment').getAttribute('aria-pressed') === 'false')
    click(row('deadline'))
    await sleep(100)
    assert('hiding Tasks too hides both tasks', !/Send the artwork/.test(grid()) && !/Book the studio/.test(grid()) && /3 hidden/.test(headerCount()))
    click(legend.querySelector('[data-legend-all]'))
    await sleep(100)
    assert('Show all brings everything back', /Northgate Studios/.test(grid()) && /Send the artwork/.test(grid()) && !/hidden/.test(headerCount()))
    assert('no source is marked withheld', !legend.querySelector('[data-withheld]'))
  } else {
    assert('Payments due is marked "not in your pages", not offered as a toggle', row('payment')?.hasAttribute('data-withheld') && /not in your pages/.test(textOf(row('payment'))) && row('payment').tagName !== 'BUTTON')
    assert('Contracts signed is withheld too', row('contract')?.hasAttribute('data-withheld'))
    assert('Renewals stays a toggle with its count', row('renewal')?.tagName === 'BUTTON' && count('renewal') === 1)
    assert('no payment renders anywhere', !/Northgate/.test(textOf(host)))
    assert('the header says your tasks only', /your tasks only/.test(headerCount()))
    assert('only the own task is on the grid', /Send the artwork/.test(grid()) && !/Book the studio/.test(grid()))
  }

  say('\nEVERY DATE LINKS TO ITS PAGE')
  const day12 = [...host.querySelectorAll('button')].find((b) => /^12/.test(textOf(b)) && /Night Drive/.test(textOf(b)))
  click(day12)
  await sleep(100)
  const panel = [...host.querySelectorAll('.card')].find((c) => /Night Drive/.test(textOf(c)) && c.querySelector('[data-event-link]'))
  const hrefs = panel ? [...panel.querySelectorAll('[data-event-link]')].map((a) => a.getAttribute('href')) : []
  assert('the day panel opened', !!panel)
  assert('the release links to /releases and the task to /my-work', hrefs.includes('/releases') && hrefs.includes('/my-work'))
  if (scenario === 'full') {
    click(host.querySelector('[data-legend-all]') || document.body)
    const day15 = [...host.querySelectorAll('button')].find((b) => /^15/.test(textOf(b)) && /Northgate/.test(textOf(b)))
    click(day15); await sleep(100)
    const p15 = [...host.querySelectorAll('.card')].find((c) => /Northgate/.test(textOf(c)) && c.querySelector('[data-event-link]'))
    assert('the payment links to /bk/payments and shows Rush', !!p15 && p15.querySelector('[data-event-link]')?.getAttribute('href') === '/bk/payments' && /Rush/.test(textOf(p15)))
  }
  assert('nothing threw along the way', errors.length === 0)
  if (errors.length) say('  ' + errors.join('\n  '))
  say('DONE'); globalThis.__DONE__ = true
}
main()
