// Is the artist profile a hub?
//
// Three tabs — Budget, Recoupments, Campaigns — each read-only here and each
// carrying the way to its page. Every one sits inside `{tab === … && …}`, so
// smoke (which renders the loading branch) never constructs the JSX; this
// mounts the profile, clicks each tab, and reads what appeared: the sheet's
// lines by figure, the link hrefs by KEY and by NAME, and the gating — a tab
// must not exist for somebody who cannot open the page behind it.
//
// Scenarios (HUB_SCENARIO env): full · nocampaign · gated
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import ArtistProfile from '../src/pages/ArtistProfile'
import { calls } from './hub-api-stub.js'
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
const findByText = (root, re, sel = '*') => [...root.querySelectorAll(sel)].filter((n) => re.test(textOf(n)))
const click = (el) => el && el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))

const scenario = (typeof process !== 'undefined' && process.env.HUB_SCENARIO) || 'full'
globalThis.__HUB_SCENARIO__ = scenario
if (scenario === 'gated') globalThis.__HOME_ALLOW__ = new Set(['/artists', '/contracts', '/artist-campaigns'])  // no budget, no recoupments

async function main() {
  say(`SCENARIO ${scenario}`)
  const host = document.createElement('div'); document.body.appendChild(host)
  createRoot(host).render(
    <Catch><ThemeProvider><ToastProvider>
      <MemoryRouter initialEntries={['/artists/12']}><Routes><Route path="/artists/:id" element={<ArtistProfile />} /></Routes></MemoryRouter>
    </ToastProvider></ThemeProvider></Catch>
  )
  for (let i = 0; i < 50 && !findByText(host, /^Overview/, 'button').length; i += 1) await sleep(100)
  await sleep(100)
  assert('the profile rendered without throwing', errors.length === 0 && /Rosa Vale/.test(textOf(host)))
  if (errors.length) say('  ' + errors.join('\n  '))
  const tabBtn = (re) => findByText(host, re, 'button').find((b) => b.closest('nav, [role="tablist"], .border-b') || true)

  if (scenario === 'gated') {
    assert('no Budget tab for somebody who cannot open /artist-budgets', !tabBtn(/^Budget$/))
    assert('no Recoupments tab for somebody who cannot open /recoupments', !tabBtn(/^Recoupments$/))
    assert('but Campaigns is still offered', !!tabBtn(/^Campaigns$/))
    say('DONE'); globalThis.__DONE__ = true; return
  }

  assert('the tab strip offers Budget, Recoupments and Campaigns', !!tabBtn(/^Budget$/) && !!tabBtn(/^Recoupments$/) && !!tabBtn(/^Campaigns$/))
  assert('the sheet is not fetched until the tab opens', !calls.get.some((u) => /simple/.test(u)))

  say('\nBUDGET')
  click(tabBtn(/^Budget$/))
  for (let i = 0; i < 30 && !host.querySelector('[data-tab="budget"] table'); i += 1) await sleep(100)
  const bt = host.querySelector('[data-tab="budget"]')
  assert('the Budget tab fetched the simple sheet by KEY', calls.get.some((u) => u === '/artist-budgets/rosavale/simple'))
  assert('it renders Budget · Spent · Left', !!bt && /Budget/.test(textOf(bt)) && /Spent/.test(textOf(bt)) && /Left/.test(textOf(bt)))
  assert('Advance 25,000 spent to the dollar', !!bt && /Advance\s*\$25,000\s*\$25,000\s*\$0/.test(textOf(bt)))
  assert('the release sits under Total marketing', !!bt && /Total marketing.*Night Drive\s*\$20,000\s*\$12,400\s*\$7,600/.test(textOf(bt)))
  assert('Total 65,000 · 44,450 · 20,550', !!bt && /Total\s*\$65,000\s*\$44,450\s*\$20,550/.test(textOf(bt)))
  assert('no inputs — the hub is read-only', !!bt && bt.querySelectorAll('input').length === 0)
  assert('"Open the sheet" links by KEY and carries the spelling', bt?.querySelector('[data-open="budget"]')?.getAttribute('href') === '/artist-budgets/rosavale?name=Rosa%20Vale')

  say('\nCONTRACT TERMS')
  window.confirm = () => true
  click(tabBtn(/^Contracts/))
  for (let i = 0; i < 30 && !host.querySelector('[data-contract-terms]'); i += 1) await sleep(100)
  const terms = host.querySelector('[data-artist-contract="5"] [data-contract-terms]')
  assert('the contract card carries the terms block', !!terms)
  assert('Deliverables 1 of 3, 2 remaining', !!terms && /1 of 3/.test(textOf(terms.querySelector('[data-term="deliverables"]'))) && /2 remaining/.test(textOf(terms.querySelector('[data-term="deliverables"]'))))
  assert('Options 0 of 2 used · period 1 · 2 left', !!terms && /0 of 2 used/.test(textOf(terms.querySelector('[data-term="options"]'))) && /2 left/.test(textOf(terms.querySelector('[data-term="options"]'))))
  assert('the period end is shown clearly with the days left', !!terms && /61 days/.test(textOf(terms.querySelector('[data-term="period-end"]'))))
  assert('label 40% · artist 60% · marketing $20,000 · advance $10,000', !!terms && /40%/.test(textOf(terms.querySelector('[data-term="label-split"]'))) && /60%/.test(textOf(terms.querySelector('[data-term="artist-split"]'))) && /20,000/.test(textOf(terms.querySelector('[data-term="marketing-budget"]'))) && /10,000/.test(textOf(terms.querySelector('[data-term="advance"]'))))
  assert('signature reads Signed, set by hand', !!terms && /Signed/.test(textOf(terms.querySelector('[data-term="signature"]'))) && /set by hand/.test(textOf(terms.querySelector('[data-term="signature"]'))))
  const exBtn = terms?.querySelector('[data-exercise-option]')
  assert('a Superadmin sees Exercise option 1', !!exBtn && /Exercise option 1/.test(textOf(exBtn)))
  click(exBtn); await sleep(200)
  assert('…which POSTs /contracts/5/exercise-option', calls.post.includes('/contracts/5/exercise-option'))
  const terms2 = host.querySelector('[data-artist-contract="5"] [data-contract-terms]')
  assert('…and the card now reads period 2, 1 option left', !!terms2 && /1 of 2 used/.test(textOf(terms2.querySelector('[data-term="options"]'))) && /period 2/.test(textOf(terms2.querySelector('[data-term="options"]'))))
  const sigSel = terms2?.querySelector('[data-signature-select]')
  if (sigSel) { sigSel.value = 'fully_executed'; sigSel.dispatchEvent(new window.Event('change', { bubbles: true })); await sleep(150) }
  assert('setting the signature by hand PUTs /contracts/5 { signature_status }', calls.put.some((c) => c.url === '/contracts/5' && c.body?.signature_status === 'fully_executed'), JSON.stringify(calls.put.slice(-1)))

  say('\nRECOUPMENTS')
  click(tabBtn(/^Recoupments$/))
  await sleep(150)
  const rt = host.querySelector('[data-tab="recoupments"]')
  assert('the Recoupments tab explains the four bank states', !!rt && /confirmed on a statement/.test(textOf(rt)) && /unpaid/.test(textOf(rt)))
  assert('and links to the artist page by NAME', rt?.querySelector('[data-open="recoupments"]')?.getAttribute('href') === '/recoupments/Rosa%20Vale')

  say('\nCAMPAIGNS')
  click(tabBtn(/^Campaigns$/))
  for (let i = 0; i < 30 && !host.querySelector('[data-tab="campaigns"] p'); i += 1) await sleep(100)
  await sleep(150)
  const ct = host.querySelector('[data-tab="campaigns"]')
  if (scenario === 'full') {
    assert('the Campaigns tab shows Settled $18,200', !!ct && /Settled\s*\$18,200/.test(textOf(ct)))
    assert('Committed $3,000 over 1 invoice', !!ct && /Committed\s*\$3,000\s*1 invoice(?!s)/.test(textOf(ct)))
    assert('Planned $40,000', !!ct && /Planned\s*\$40,000/.test(textOf(ct)))
    assert("it picked THIS artist's card, not Darci's", !!ct && !/\$900/.test(textOf(ct)))
  } else {
    assert('with no card, the tab says so and points at how one appears', !!ct && /No campaign spend on Rosa Vale yet/.test(textOf(ct)) && /marketing invoices are approved/.test(textOf(ct)))
  }
  assert('and links to the campaigns page by NAME', ct?.querySelector('[data-open="campaigns"]')?.getAttribute('href') === '/artist-campaigns/Rosa%20Vale')
  assert('nothing threw along the way', errors.length === 0)
  if (errors.length) say('  ' + errors.join('\n  '))
  say('DONE'); globalThis.__DONE__ = true
}
main()
