// Do the hand-offs hand off?
//
// A signed deal opens the contract form with the artist filled in — or offers
// to add them to the roster; a saved contract opens Add release with the
// artist filled in; a created release prompts for the budget sheet by KEY.
// None of this is reachable by smoke (effects never fire), and each is a URL
// carried from one page to the next, which is exactly the thing that breaks
// silently when a param name or a key function changes.
//
// Scenarios (HANDOFF_SCENARIO env): contracts · releases · prompt
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Contracts from '../src/pages/Contracts'
import Releases from '../src/pages/Releases'
import NextStepPrompt from '../src/components/NextStepPrompt'
import { calls } from './handoff-api-stub.js'
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
const findByText = (root, re, sel = '*') => [...root.querySelectorAll(sel)].filter((n) => re.test(textOf(n)))
const click = (el) => el && el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
const type = (el, text) => { setter.call(el, text); el.dispatchEvent(new window.Event('input', { bubbles: true })) }

const scenario = (typeof process !== 'undefined' && process.env.HANDOFF_SCENARIO) || 'contracts'

function mount(url, routes) {
  const host = document.createElement('div'); document.body.appendChild(host)
  createRoot(host).render(
    <Catch><ThemeProvider><ToastProvider>
      <MemoryRouter initialEntries={[url]}><Routes>{routes}</Routes></MemoryRouter>
    </ToastProvider></ThemeProvider></Catch>
  )
  return host
}

async function main() {
  say(`SCENARIO ${scenario}`)
  if (scenario === 'contracts') {
    const host = mount('/contracts?new=1&artist=Rosa%20Vale', <Route path="/contracts" element={<Contracts />} />)
    for (let i = 0; i < 40 && !host.querySelector('[data-roster-gap]'); i += 1) await sleep(100)
    await sleep(100)
    assert('the page did not throw', errors.length === 0); if (errors.length) say('  ' + errors.join('\n  '))
    const gap = host.querySelector('[data-roster-gap]')
    assert('?new=1 opened the new-contract form', /New Contract|Type \*/.test(textOf(host)))
    assert('the deal named someone not on the roster, and the form says so', !!gap && /Rosa Vale.*not on the roster/.test(textOf(gap)))
    const addBtn = gap && findByText(gap, /Add Rosa Vale to the roster/, 'button')[0]
    assert('it offers to add them', !!addBtn)
    click(addBtn)
    await sleep(200)
    const post = calls.post.find((c) => c.url === '/artists')
    assert('clicking it POSTs /artists with the name', !!post && post.body.name === 'Rosa Vale')
    assert('the gap notice is gone', !host.querySelector('[data-roster-gap]'))
    const picker = [...host.querySelectorAll('input')].find((i) => i.value === 'Rosa Vale')
    assert('and the artist picker now holds Rosa Vale', !!picker)
  }
  if (scenario === 'releases') {
    const host = mount('/releases?add=1&artist=Rosa%20Vale', <Route path="/releases" element={<Releases />} />)
    for (let i = 0; i < 40 && !host.querySelector('input[list="artist-list-new"]'); i += 1) await sleep(100)
    await sleep(100)
    assert('the page did not throw', errors.length === 0); if (errors.length) say('  ' + errors.join('\n  '))
    const artistInput = host.querySelector('input[list="artist-list-new"]')
    assert('?add=1 opened Add release', !!artistInput)
    assert('with the artist filled in', artistInput && artistInput.value === 'Rosa Vale')
    const form = artistInput && artistInput.closest('form')
    const title = form && [...form.querySelectorAll('input')].find((i) => /project|title|name/i.test(i.placeholder || '') && i !== artistInput)
    if (title) type(title, 'Night Drive')
    form && form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    await sleep(300)
    const post = calls.post.find((c) => c.url === '/releases')
    assert('submitting POSTs /releases with the artist', !!post && post.body.artist_name === 'Rosa Vale')
    const prompt = host.querySelector('[data-next-step]')
    assert('a hand-off prompt appears', !!prompt)
    const link = prompt && prompt.querySelector('[data-next-step-link]')
    assert('it points at the budget sheet by KEY, carrying the spelling',
      !!link && link.getAttribute('href') === '/artist-budgets/rosavale?name=Rosa%20Vale')
    assert('and names the artist', prompt && /Rosa Vale/.test(textOf(prompt)))
  }
  if (scenario === 'prompt') {
    const host = document.createElement('div'); document.body.appendChild(host)
    let closed = 0
    createRoot(host).render(
      <MemoryRouter><NextStepPrompt onClose={() => { closed += 1 }} prompt={{ key: 1, title: 'Rosa Vale is signed', body: 'Next is the contract.', to: '/contracts?new=1&artist=Rosa%20Vale&deal=3', label: 'Create the contract' }} /></MemoryRouter>
    )
    await sleep(100)
    const el = host.querySelector('[data-next-step]')
    assert('the prompt renders title, body and the link', !!el && /Rosa Vale is signed/.test(textOf(el)) && /Next is the contract/.test(textOf(el)))
    assert('the link carries the prefill params', el.querySelector('[data-next-step-link]')?.getAttribute('href') === '/contracts?new=1&artist=Rosa%20Vale&deal=3')
    click(findByText(el, /^Not now$/, 'button')[0])
    assert('Not now dismisses', closed === 1)
  }
  say('DONE'); globalThis.__DONE__ = true
}
main()
