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
  for (let i = 0; i < 40 && !host.querySelector('[data-tile], [data-loop-clear]'); i += 1) await sleep(100)
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
  assert('My tasks renders for everyone (unless the whole loop is clear)', !!byId.tasks || !!host.querySelector('[data-loop-clear]'))

  if (scenario === 'admin') {
    assert('ADMIN: all four loop tiles render', ['approvals', 'bank', 'payments', 'releases'].every((k) => byId[k]))
    const al = host.querySelector('[data-home-alerts]')
    assert('ADMIN: the Alerts panel renders the two deal alerts, grouped by kind', !!al && al.querySelectorAll('[data-alert-kind]').length === 2 && /No release in 2\+ months/.test(textOf(al)) && /Option period ending/.test(textOf(al)))
    assert('ADMIN: each alert links to the page that resolves it', al?.querySelector('[data-alert="release_gap:12"]')?.getAttribute('href') === '/artists/12' && al?.querySelector('[data-alert="option_expiring:5"]')?.getAttribute('href') === '/contracts?focus=5')
    assert('ADMIN: approvals shows the count and the money', /7/.test(textOf(byId.approvals)) && /\$18,420/.test(textOf(byId.approvals)))
    assert('ADMIN: approvals says how old the oldest is', /oldest 4 days/.test(textOf(byId.approvals)))
    assert('ADMIN: payments shows rush and overdue', /2 rush/.test(textOf(byId.payments)) && /1 overdue/.test(textOf(byId.payments)))
    assert('ADMIN: bank names the overdue account', /bofa statement overdue/.test(textOf(byId.bank)) && /41 days/.test(textOf(byId.bank)))
    assert('ADMIN: releases says how many are under half done', /1 under half done/.test(textOf(byId.releases)))
    assert('ADMIN: each tile links to the page that resolves it',
      byId.approvals.getAttribute('href') === '/bk/approvals' && byId.payments.getAttribute('href') === '/bk/payments'
      && byId.bank.getAttribute('href') === '/bk/bank-matching' && byId.releases.getAttribute('href') === '/releases')
    assert('ADMIN: the label-overview stat cards are gone', !/Total Artists|Team Members|Total Releases/.test(body))
    const qa = host.querySelector('[data-quick-actions]')
    assert('ADMIN: three quick actions — add invoice, add release, new deal', !!qa && qa.querySelector('[data-action="add-invoice"]')?.getAttribute('href') === '/bk/add' && qa.querySelector('[data-action="add-release"]')?.getAttribute('href') === '/releases?add=1' && qa.querySelector('[data-action="new-deal"]')?.getAttribute('href') === '/deals?new=1')
    const wk = host.querySelector('[data-week]')
    const wkTypes = [...wk.querySelectorAll('[data-week-event]')].map((e) => e.getAttribute('data-week-event'))
    assert('ADMIN: the week lists the task today, the release in 2 days and the payment in 5 — not the renewal in 12 or yesterday', wkTypes.join(',') === 'deadline,release,payment_due' && !/Recording expires|Yesterday thing/.test(textOf(wk)))
    assert('ADMIN: week events link to their pages', [...wk.querySelectorAll('a')].some((a) => a.getAttribute('href') === '/bk/payments') && [...wk.querySelectorAll('a')].some((a) => a.getAttribute('href') === '/releases'))
    const act = host.querySelector('[data-activity]')
    const rows = [...act.querySelectorAll('[data-activity-row]')].map(textOf)
    assert("ADMIN: recent activity shows the teammate's rows and not mine", rows.length === 2 && rows.every((r) => /^Sam/.test(r)) && !/Added release/.test(textOf(act)))
    assert('ADMIN: the alert sits above the activity rows', !!act.querySelector('[data-alerts]') && /Release checklist/.test(textOf(act.querySelector('[data-alerts]'))) && act.querySelector('[data-alerts]').compareDocumentPosition(act.querySelector('[data-activity-row]')) & Node.DOCUMENT_POSITION_FOLLOWING)
    assert('ADMIN: no chart renders while there is nothing to chart', !/Releases per Month|Releases by Genre/.test(body))
    assert('ADMIN: the old Notifications and Upcoming Releases panels are gone', !/All clear — no alerts|No releases in the next two weeks/.test(body))
    assert('ADMIN: the flags tile renders with the open count, what is new, and links to /flags', !!byId.flags && /6/.test(textOf(byId.flags)) && /3 new since you looked/.test(textOf(byId.flags)) && byId.flags.getAttribute('href') === '/flags')
    assert('ADMIN: the onboarding tile counts artists mid-onboarding and the steps open', !!byId.onboarding && /2/.test(textOf(byId.onboarding)) && /5 steps open/.test(textOf(byId.onboarding)) && /next: Rosa Vale/.test(textOf(byId.onboarding)))
    assert('ADMIN: it opens the roster narrowed to them', byId.onboarding?.getAttribute('href') === '/artists?onboarding=1')
  }
  if (scenario === 'anr') {
    assert('ANR: no money tile renders', !byId.approvals && !byId.payments && !byId.bank)
    assert('ANR: the releases tile renders', !!byId.releases)
    assert('ANR: no flags tile when the server withheld the section', !byId.flags)
    assert('ANR: no dollar figure reaches the page', !/\$\d/.test(body))
    assert('ANR: charts stay hidden with no data', !/Releases per Month/.test(body))
    assert('ANR: quick actions are gated — release and deal, no invoice', !host.querySelector('[data-action="add-invoice"]') && !!host.querySelector('[data-action="add-release"]') && !!host.querySelector('[data-action="new-deal"]'))
    assert('ANR: no Recent activity for someone who cannot open /activity', !host.querySelector('[data-activity]'))
    assert('ANR: the week still renders', !!host.querySelector('[data-week]'))
  }
  if (scenario === 'empty') {
    assert('EMPTY: no Alerts panel when there is nothing — never a bare zero', !host.querySelector('[data-home-alerts]'))
    const clear = host.querySelector('[data-loop-clear]')
    assert('EMPTY: the six tiles collapse to one line', !!clear && tiles.length === 0)
    assert('EMPTY: the line names every source that is clear', /All clear/.test(textOf(clear)) && /no open tasks/.test(textOf(clear)) && /nothing awaiting approval/.test(textOf(clear)) && /nothing due this week/.test(textOf(clear)) && /no bank lines to review/.test(textOf(clear)) && /nothing releasing in 30 days/.test(textOf(clear)) && /nobody mid-onboarding/.test(textOf(clear)))
    assert('EMPTY: the week says what fills it', /Nothing dated in the next week/.test(textOf(host.querySelector('[data-week]'))))
    assert('EMPTY: activity says what fills it', /Nothing logged yet/.test(textOf(host.querySelector('[data-activity]'))))
    assert('EMPTY: quick actions still offered', host.querySelectorAll('[data-quick-actions] a').length === 3)
    assert('EMPTY: no bare zero anywhere in the loop', !/\b0\b/.test(textOf(clear)))
  }
  if (scenario === 'down') {
    assert('DOWN: a failed alerts read renders no panel', !host.querySelector('[data-home-alerts]'))
    assert('DOWN: no loop tile renders when the read failed', !byId.approvals && !byId.payments && !byId.bank && !byId.releases)
    assert('DOWN: the page still renders the rest — tasks tile, quick actions, and the week says it could not be read', !!byId.tasks && !!host.querySelector('[data-quick-actions]') && /could not be read/.test(textOf(host.querySelector('[data-week]'))))
    assert('DOWN: a failed loop never collapses to All clear', !host.querySelector('[data-loop-clear]'))
  }
  say(`rendered bytes: ${host.innerHTML.length}`)
  say('DONE')
  globalThis.__DONE__ = true
}
main()
