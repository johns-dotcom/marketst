// Does the simple artist budget sheet render, and does typing in a cell write
// the right thing?
//
// `npm run smoke` cannot answer either: it renders under `renderToString`,
// where effects never fire, so the page only ever draws its skeleton. Every
// number here is behind `/artist-budgets/:key/simple`.
//
// What is at risk is the WRITE PATH — a typed advance must PUT to /advance with
// the parsed number, a typed release budget must carry its release_id, Esc
// must write nothing — and the ALLOCATION line, which is the one piece of
// arithmetic on the page: releases add up to a figure that is compared against
// Total marketing and flagged when it exceeds it.
//
// Scenarios: full · empty (SIMPLE_SCENARIO env).
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import ArtistBudgetSimple from '../src/pages/ArtistBudgetSimple'
import { calls } from './budgetsimple-api-stub.js'
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

const scenario = (typeof process !== 'undefined' && process.env.SIMPLE_SCENARIO) || 'full'
globalThis.__SIMPLE_SCENARIO__ = scenario

// Type into a controlled React input: set the value through the native setter
// so React's tracker sees the change, then fire input, then blur to commit.
// React 18 wires onFocus/onBlur to the BUBBLING focusin/focusout events, so a
// plain `blur` dispatched on the element never reaches the handler.
const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
const focus = (el) => { el.focus(); el.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true })) }
const blur = (el) => el.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }))
const type = (el, text) => { setter.call(el, text); el.dispatchEvent(new window.Event('input', { bubbles: true })) }
function typeAndBlur(input, text) { focus(input); type(input, text); blur(input) }
function typeAndEscape(input, text) {
  focus(input); type(input, text)
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  blur(input)
}

async function main() {
  say(`SCENARIO ${scenario}`)
  const host = document.createElement('div')
  document.body.appendChild(host)
  createRoot(host).render(
    <Catch><ThemeProvider><ToastProvider>
      <MemoryRouter initialEntries={[scenario === 'empty' ? '/artist-budgets/newkid?name=New%20Kid' : '/artist-budgets/rosavale']}>
        <Routes><Route path="/artist-budgets/:artistKey" element={<ArtistBudgetSimple />} /></Routes>
      </MemoryRouter>
    </ToastProvider></ThemeProvider></Catch>
  )
  for (let i = 0; i < 40 && !host.querySelector('[data-simple-sheet]'); i += 1) await sleep(100)
  await sleep(100)
  const body = () => textOf(host)
  const row = (sel) => host.querySelector(sel)
  assert('the page did not throw', errors.length === 0)
  if (errors.length) say('  ' + errors.join('\n  '))
  assert('it rendered the sheet', !!row('[data-simple-sheet]'))

  if (scenario === 'full') {
    say('\nTHE SHAPE')
    assert('the title is the artist', /Rosa Vale/.test(body()))
    assert('three column headings: Budget · Spent · Left', /Budget/.test(body()) && /Spent/.test(body()) && /Left/.test(body()) && !/Committed|Variance/.test(body()))
    assert('Advance, Total marketing, Other spend and Total are the lines', !!row('[data-line="advance"]') && !!row('[data-line="marketing"]') && !!row('[data-line="other"]') && !!row('[data-line="total"]'))
    assert('two releases sit under Total marketing', host.querySelectorAll('[data-release]').length === 2)
    assert('the release rows come AFTER the marketing row', row('[data-line="marketing"]').compareDocumentPosition(row('[data-release="9"]')) & Node.DOCUMENT_POSITION_FOLLOWING)
    assert('Advance shows spent 25,000 and left $0 (spent to the dollar)', /\$25,000/.test(textOf(row('[data-line="advance"]'))) && /\$0\b/.test(textOf(row('[data-line="advance"]'))))
    assert('Total marketing shows the gap: allocated 30,000 of 40,000', /allocated \$30,000 of \$40,000/.test(textOf(row('[data-allocated]'))) && /\$10,000 not yet allocated/.test(textOf(row('[data-allocated]'))))
    assert('unpaid rides as a note, not a column', /\+\$3,000 unpaid/.test(textOf(row('[data-line="marketing"]'))))
    assert('Other spend is read-only and names its categories', /Tour\/Live \$1,250/.test(textOf(row('[data-line="other"]'))) && row('[data-line="other"]').querySelectorAll('input').length === 0)
    assert('Total adds the lines: 65,000 · 44,450 · 20,550', /\$65,000/.test(textOf(row('[data-line="total"]'))) && /\$44,450/.test(textOf(row('[data-line="total"]'))) && /\$20,550/.test(textOf(row('[data-line="total"]'))))
    assert('Full breakdown links to the detail grid', row('[data-action="full-breakdown"]')?.getAttribute('href') === '/artist-budgets/rosavale/detail')
    assert('exactly four editable cells: advance, marketing, two releases', host.querySelectorAll('input').length === 4)
    const crumb = host.querySelector('nav')
    assert('a breadcrumb reads Artists › Rosa Vale › Budget', !!crumb && /Artists.*Rosa Vale.*Budget/.test(textOf(crumb)))
    assert('and the artist crumb links to the profile by roster id', !!crumb && [...crumb.querySelectorAll('a')].some((a) => a.getAttribute('href') === '/artists/12' && /Rosa Vale/.test(textOf(a))))

    say('\nTHE WRITE PATH')
    const adv = row('[data-line="advance"] input')
    typeAndBlur(adv, '$30,000')
    await sleep(200)
    const advPut = calls.put.find((c) => /\/advance$/.test(c.url))
    assert('typing "$30,000" in Advance PUTs /advance with amount 30000', !!advPut && advPut.body.amount === 30000)
    assert('and the sheet reloaded with the new figure in the cell', row('[data-line="advance"] input').value === '30000')

    const rel = row('[data-release="9"] input')
    typeAndBlur(rel, '25000')
    await sleep(200)
    const relPut = calls.put.find((c) => /\/release$/.test(c.url))
    assert('typing a release budget PUTs /release with release_id 9 and amount 25000', !!relPut && relPut.body.release_id === 9 && relPut.body.amount === 25000)
    assert('allocation now reads 35,000 of 40,000', /allocated \$35,000 of \$40,000/.test(textOf(row('[data-allocated]'))))

    const before = calls.put.length
    typeAndEscape(row('[data-line="marketing"] input'), '1')
    await sleep(150)
    assert('Esc writes nothing', calls.put.length === before)
    assert('and the old value is back in the cell', row('[data-line="marketing"] input').value === '40000')

    typeAndBlur(row('[data-line="marketing"] input'), '30000')
    await sleep(200)
    assert('lowering Total marketing below the releases flags over-allocation', /more than the total/.test(textOf(row('[data-allocated]'))))

    typeAndBlur(row('[data-release="7"] input'), 'abc')
    await sleep(150)
    assert('a non-number writes nothing', !calls.put.some((c) => /\/release$/.test(c.url) && c.body.release_id === 7))
  }

  if (scenario === 'empty') {
    const crumb0 = host.querySelector('nav')
    assert('off the roster, the breadcrumb still names the artist but has no profile link', !!crumb0 && /New Kid/.test(textOf(crumb0)) && ![...crumb0.querySelectorAll('a')].some((a) => /New Kid/.test(textOf(a))))
    say('\nTHE EMPTY SHEET')
    assert('the opened-with name titles a sheet the server could only name by key', /New Kid/.test(body()) && !/newkid/.test(textOf(host.querySelector('h1') || host)))
    assert('it says what to do', /Type the advance and the marketing total below/.test(body()))
    assert('no releases → says where to add one', /add one on Releases/.test(body()))
    assert('the two totals are still editable', host.querySelectorAll('input').length === 2)
    assert('the total row shows dashes, not zeros', /—/.test(textOf(row('[data-line="total"]'))) && !/\$0/.test(textOf(row('[data-line="total"]'))))
  }
  say(`rendered bytes: ${host.innerHTML.length}`)
  say('DONE')
  globalThis.__DONE__ = true
}
main()
