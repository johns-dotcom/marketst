// Does the signing checklist show, link and act?
//
// The profile panel: five steps from the server, each linking to its page; the
// payment step offers the vendor-form link and a typed-in form (bookkeeping
// roles only) whose POST names the method and never echoes a number; without
// an email it asks for one. Complete → one collapsed line. The roster: a chip
// on the artist mid-onboarding and a filter that narrows to them.
//
// Scenarios (ONB_SCENARIO env): open · complete · noemail · roster
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import ArtistProfile from '../src/pages/ArtistProfile'
import Artists from '../src/pages/Artists'
import { calls } from './onboarding-api-stub.js'
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
const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
const type = (el, text) => { setter.call(el, text); el.dispatchEvent(new window.Event('input', { bubbles: true })) }
const scenario = (typeof process !== 'undefined' && process.env.ONB_SCENARIO) || 'open'
globalThis.__ONB_SCENARIO__ = scenario

function mount(url, routes) {
  const host = document.createElement('div'); document.body.appendChild(host)
  createRoot(host).render(<Catch><ThemeProvider><ToastProvider><MemoryRouter initialEntries={[url]}><Routes>{routes}</Routes></MemoryRouter></ToastProvider></ThemeProvider></Catch>)
  return host
}

async function main() {
  say(`SCENARIO ${scenario}`)
  if (scenario === 'roster') {
    const host = mount('/artists?onboarding=1', <Route path="/artists" element={<Artists />} />)
    for (let i = 0; i < 50 && !host.querySelector('[data-onboarding-chip]'); i += 1) await sleep(100)
    await sleep(100)
    assert('the roster rendered', errors.length === 0 && /Rosa Vale/.test(textOf(host)))
    if (errors.length) say('  ' + errors.join('\n  '))
    const chip = host.querySelector('[data-onboarding-chip]')
    assert('Rosa Vale carries an "Onboarding 2 of 5" chip', !!chip && /Onboarding 2 of 5/.test(textOf(chip)))
    assert('the chip names the open steps on hover', /Payment details and W-9/.test(chip?.getAttribute('title') || '') && /Advance paid/.test(chip?.getAttribute('title') || ''))
    assert('?onboarding=1 narrows the roster: Darci is hidden', !/Darci/.test(textOf(host)))
    const filter = host.querySelector('[data-onboarding-filter]')
    assert('the filter button is pressed and counts 1', !!filter && filter.getAttribute('aria-pressed') === 'true' && /Onboarding · 1/.test(textOf(filter)))
    click(filter); await sleep(100)
    assert('clicking it brings Darci back', /Darci/.test(textOf(host)))
    say('DONE'); globalThis.__DONE__ = true; return
  }

  const host = mount('/artists/12', <Route path="/artists/:id" element={<ArtistProfile />} />)
  for (let i = 0; i < 50 && !host.querySelector('[data-onboarding]'); i += 1) await sleep(100)
  await sleep(150)
  assert('the profile rendered with the onboarding panel', errors.length === 0 && !!host.querySelector('[data-onboarding]'))
  if (errors.length) say('  ' + errors.join('\n  '))
  const panel = host.querySelector('[data-onboarding]')

  if (scenario === 'complete') {
    assert('complete → one line: Onboarded on 2 Oct 2026', panel.hasAttribute('data-onboarding-complete') && /Onboarded on Oct 2, 2026|Onboarded on 2 Oct 2026/.test(textOf(panel)))
    assert('the steps are hidden until asked', !panel.querySelector('[data-onboarding-steps]'))
    click(panel.querySelector('button')); await sleep(100)
    assert('"show steps" reveals all five, ticked', panel.querySelectorAll('[data-onboarding-steps] li').length === 5)
    say('DONE'); globalThis.__DONE__ = true; return
  }

  say('\nTHE STEPS')
  assert('header reads Onboarding · 2 of 5, signed 18 Sep', /Onboarding · 2 of 5/.test(textOf(panel)) && /Signed Sep 18, 2026|Signed 18 Sep 2026/.test(textOf(panel)) && /Master License/.test(textOf(panel)))
  const steps = [...panel.querySelectorAll('[data-step]')]
  assert('five steps in order', steps.map((s) => s.getAttribute('data-step')).join(',') === 'contract,payment,advance,budget,release')
  assert('two ticked (contract, budget), three open', steps.filter((s) => s.getAttribute('data-done') === '1').map((s) => s.getAttribute('data-step')).join(',') === 'contract,budget')
  const link = (k) => panel.querySelector(`[data-step="${k}"] [data-step-link]`)?.getAttribute('href')
  assert('advance links to Payments, release to Add release prefilled, budget to the sheet by key', link('advance') === '/bk/payments' && link('release') === '/releases?add=1&artist=Rosa%20Vale' && link('budget') === '/artist-budgets/rosavale?name=Rosa%20Vale')
  assert('the advance step says what is due', /\$25,000 due 2026-10-18/.test(textOf(steps[2])))

  say('\nPAYMENT DETAILS')
  const pay = panel.querySelector('[data-step="payment"]')
  if (scenario === 'noemail') {
    const form = pay.querySelector('[data-add-email]')
    assert('with no email, the step asks for one instead of offering the link', !!form && !pay.querySelector('[data-copy-link]'))
    type(form.querySelector('input'), 'rosa@example.test')
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await sleep(200)
    const put = calls.put.find((c) => c.url === '/artists/12/contact')
    assert('saving it PUTs /artists/12/contact with the email', !!put && put.body.email === 'rosa@example.test')
    say('DONE'); globalThis.__DONE__ = true; return
  }
  assert('it offers to copy the vendor form link and to email it to the artist', !!pay.querySelector('[data-copy-link]') && /rosa@example.test/.test(decodeURIComponent(pay.querySelector('[data-mail-link]')?.getAttribute('href') || '')))
  assert('the mail body carries the /submit link and the payee name', /%2Fsubmit/.test(pay.querySelector('[data-mail-link]').getAttribute('href')) && /Rosa%20Vale/.test(pay.querySelector('[data-mail-link]').getAttribute('href')))
  const typeIn = pay.querySelector('[data-type-in]')
  assert('a Superadmin sees "Type in"', !!typeIn)
  click(typeIn); await sleep(100)
  const form = pay.querySelector('[data-typein]')
  assert('the typed-in form opens on ACH with six fields', !!form && form.querySelectorAll('input, select').length === 7)
  const set = (name, v) => { const el = [...form.querySelectorAll('label')].find((l) => new RegExp(name, 'i').test(textOf(l)))?.querySelector('input, select'); if (el?.tagName === 'SELECT') { el.value = v; el.dispatchEvent(new window.Event('change', { bubbles: true })) } else type(el, v) }
  set('Account number', '000123456789'); set('Routing', '021000021'); set('Account type', 'Checking'); set('Name on', 'Rosa Vale'); set('Bank name', 'Chase'); set('Bank address', '1 Main St, NYC')
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await sleep(250)
  const post = calls.post.find((c) => c.url === '/artists/12/payment-details')
  assert('submitting POSTs /artists/12/payment-details with the method and the field names the server validates', !!post && post.body.payment_method === 'ACH' && post.body.payment_account_number === '000123456789' && post.body.payment_routing_number === '021000021' && post.body.payment_account_type === 'Checking')
  assert('after saving, the form closes and the checklist is re-read', !pay.querySelector('[data-typein]') && calls.get.filter((u) => /onboarding/.test(u)).length >= 2)
  assert('no account number is rendered anywhere on the page', !/000123456789/.test(textOf(host)))
  assert('nothing threw', errors.length === 0)
  if (errors.length) say('  ' + errors.join('\n  '))
  say('DONE'); globalThis.__DONE__ = true
}
main()
