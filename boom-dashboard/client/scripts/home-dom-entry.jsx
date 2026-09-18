// Does the Home page draw the loop, and only for who may see it?
//
// `npm run smoke` cannot answer this: it renders under `renderToString`, where
// effects never fire, so Home only ever draws its loading skeleton. Every tile
// is behind `/dashboard/loop`, which is exactly the branch smoke never reaches.
//
// Four things can go wrong and none throws:
//
//   a money tile renders for somebody who cannot open the page → a trapdoor
//   a tile shows "0" where the empty sentence should be         → teaches nothing
//   the loop endpoint fails and the tiles render as zeros        → "nothing to do" is a lie
//   a tile links somewhere other than the page that resolves it → the contract
//
// Scenarios: admin · anr · empty · down (HOME_SCENARIO env, default runs all).
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import Dashboard from '../src/pages/Dashboard'
import { calls } from './home-api-stub.js'
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

const scenario = (typeof process !== 'undefined' && process.env.HOME_SCENARIO) || 'admin'
globalThis.__HOME_SCENARIO__ = scenario
// Who is looking. An A&R User holds the A&R preset's paths and nothing else.
const ALLOW = {
  admin: null,
  empty: null,
  down: null,
  anr: new Set(['/', '/my-work', '/messages', '/calendar', '/flags', '/artists', '/releases', '/catalog',
                '/deals', '/contracts', '/pending-contracts', '/renewals']),
}
globalThis.__HOME_ALLOW__ = ALLOW[scenario]
globalThis.__HOME_ROLE__ = scenario === 'anr' ? 'User' : 'Superadmin'

async function main() {
  say(`SCENARIO ${scenario}`)
  const host = document.createElement('div')
  document.body.appendChild(host)
  createRoot(host).render(
    <Catch>
      <ThemeProvider>
        <ToastProvider>
          <MemoryRouter initialEntries={['/']}>
            <Dashboard />
          </MemoryRouter>
        </ToastProvider>
      </ThemeProvider>
    </Catch>
  )
  for (let i = 0; i < 40 && !host.querySelector('[data-tile]'); i += 1) await sleep(100)
  await sleep(150)

  const tiles = [...host.querySelectorAll('[data-tile]')]
  const byId = Object.fromEntries(tiles.map((t) => [t.getAttribute('data-tile'), t]))
  const ids = Object.keys(byId).sort()
  const body = textOf(host)
  say('  tiles: ' + ids.join(', '))
  assert('the page did not throw', errors.length === 0)
  if (errors.length) say('  ' + errors.join('\n  '))
  assert('the loop was read exactly once', calls.get.filter((u) => u.startsWith('/dashboard/loop')).length === 1)
  assert('the old fan-out to /bk/pending-count is gone', !calls.get.some((u) => u.startsWith('/bk/pending-count')))
  assert('My tasks renders for everyone', !!byId.tasks)

  if (scenario === 'admin') {
    assert('ADMIN: all four loop tiles render', ['approvals', 'bank', 'payments', 'releases'].every((k) => byId[k]))
    assert('ADMIN: approvals shows the count and the money', /7/.test(textOf(byId.approvals)) && /\$18,420/.test(textOf(byId.approvals)))
    assert('ADMIN: approvals says how old the oldest is', /oldest 4 days/.test(textOf(byId.approvals)))
    assert('ADMIN: payments shows rush and overdue', /2 rush/.test(textOf(byId.payments)) && /1 overdue/.test(textOf(byId.payments)))
    assert('ADMIN: bank names the overdue account', /bofa statement overdue/.test(textOf(byId.bank)) && /41 days/.test(textOf(byId.bank)))
    assert('ADMIN: releases says how many are under half done', /1 under half done/.test(textOf(byId.releases)))
    assert('ADMIN: each tile links to the page that resolves it',
      byId.approvals.getAttribute('href') === '/bk/approvals' && byId.payments.getAttribute('href') === '/bk/payments'
      && byId.bank.getAttribute('href') === '/bk/bank-matching' && byId.releases.getAttribute('href') === '/releases')
    assert('ADMIN: the label-overview stat cards are gone', !/Total Artists|Team Members|Total Releases/.test(body))
  }
  if (scenario === 'anr') {
    assert('ANR: no money tile renders', !byId.approvals && !byId.payments && !byId.bank)
    assert('ANR: the releases tile renders', !!byId.releases)
    assert('ANR: no dollar figure reaches the page', !/\$\d/.test(body))
    assert('ANR: release charts still render for someone who can open Releases', /Releases per Month/.test(body))
  }
  if (scenario === 'empty') {
    assert('EMPTY: approvals says what fills it', /Nothing waiting/.test(textOf(byId.approvals)) && /\/submit/.test(textOf(byId.approvals)))
    assert('EMPTY: payments says what fills it', /Nothing due in the next 7 days/.test(textOf(byId.payments)))
    assert('EMPTY: bank says no statement has been uploaded', /No statement uploaded yet/.test(textOf(byId.bank)))
    assert('EMPTY: bank links to Statements, not the review queue', byId.bank.getAttribute('href') === '/bk/statements')
    assert('EMPTY: releases says how to add one', /Nothing scheduled in the next 30 days/.test(textOf(byId.releases)))
    assert('EMPTY: no tile shows a bare zero', !tiles.some((t) => /^\s*0\s*$/.test(t.querySelector('p.text-2xl')?.textContent || '')))
  }
  if (scenario === 'down') {
    assert('DOWN: no loop tile renders when the read failed', !byId.approvals && !byId.payments && !byId.bank && !byId.releases)
    assert('DOWN: the page still renders the rest', !!byId.tasks && /Notifications/.test(body))
  }
  say(`rendered bytes: ${host.innerHTML.length}`)
  say('DONE')
  globalThis.__DONE__ = true
}
main()
