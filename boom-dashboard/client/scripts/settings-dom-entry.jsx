// Settings in two halves, and People as one page — under jsdom.
//
// Scenarios (SET_SCENARIO env): admin · user · people
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Settings from '../src/pages/Settings'
import Team from '../src/pages/Team'
import SettingsShell from '../src/components/SettingsShell'
import { calls, BOOKKEEPER_PAGES } from './settings-api-stub.js'
import { ThemeProvider } from '../src/context/ThemeContext'
import { ToastProvider } from '../src/context/ToastContext'
import { BoomRepsProvider } from '../src/context/BoomRepsContext'

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
const click = (el) => el && el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
const type = (el, text) => { setter.call(el, text); el.dispatchEvent(new window.Event('input', { bubbles: true })) }
const scenario = (typeof process !== 'undefined' && process.env.SET_SCENARIO) || 'admin'
globalThis.__HOME_ROLE__ = scenario === 'user' ? 'User' : 'Superadmin'
globalThis.__HOME_ALLOW__ = scenario === 'user' ? new Set(['/', '/settings', '/messages', '/releases']) : null

function mount(url, routes) {
  const host = document.createElement('div'); document.body.appendChild(host)
  createRoot(host).render(<Catch><ThemeProvider><ToastProvider><BoomRepsProvider><MemoryRouter initialEntries={[url]}><Routes>{routes}</Routes></MemoryRouter></BoomRepsProvider></ToastProvider></ThemeProvider></Catch>)
  return host
}

async function main() {
  say(`SCENARIO ${scenario}`)
  if (scenario === 'people') {
    const host = mount('/team', <Route path="/team" element={<SettingsShell><Team /></SettingsShell>} />)
    for (let i = 0; i < 50 && !host.querySelector('[data-directory] tbody tr'); i += 1) await sleep(100)
    await sleep(150)
    assert('People renders the directory for an admin', errors.length === 0 && host.querySelectorAll('[data-directory] tbody tr').length === 3)
    if (errors.length) say('  ' + errors.join('\n  '))
    const row = (id) => host.querySelector(`[data-person="${id}"]`)
    assert('the Superadmin reads "everything"', /everything/.test(textOf(row(1).querySelector('[data-access]'))))
    assert("Sam's rows add up to the bookkeeper preset", /bookkeeper/i.test(textOf(row(2).querySelector('[data-access]'))) && new RegExp(`${BOOKKEEPER_PAGES.length} pages`).test(textOf(row(2).querySelector('[data-access]'))))
    assert('Rosa is invite pending with a resend link', /invite pending/.test(textOf(row(3).querySelector('[data-last-signin]'))) && !!row(3).querySelector('[data-resend-invite]'))
    assert('last sign-in reads today / 2 days ago', /today/.test(textOf(row(1).querySelector('[data-last-signin]'))) && /2 days ago/.test(textOf(row(2).querySelector('[data-last-signin]'))))
    click(row(3).querySelector('[data-resend-invite]')); await sleep(200)
    assert('resend POSTs /settings/users/3/invite', calls.post.some((c) => c.url === '/settings/users/3/invite'))
    assert('the header offers Add a person and the page is titled People', !!host.querySelector('[data-invite]') && /People/.test(textOf(host.querySelector('h1'))))
    assert('the Settings rail is on screen with People lit — no drop out of Settings', !!host.querySelector('[data-settings-shell]') && host.querySelector('[data-tab="people"]')?.getAttribute('aria-current') === 'page')
    say('DONE'); globalThis.__DONE__ = true; return
  }
  const host = mount('/settings', <Route path="/settings" element={<SettingsShell><Settings /></SettingsShell>} />)
  for (let i = 0; i < 50 && !host.querySelector('[data-tab-profile]'); i += 1) await sleep(100)
  await sleep(150)
  assert('Settings renders on Profile', errors.length === 0 && !!host.querySelector('[data-tab-profile]'))
  if (errors.length) say('  ' + errors.join('\n  '))
  const sections = [...host.querySelectorAll('[data-settings-section]')].map((s) => s.getAttribute('data-settings-section'))
  const tabs = [...host.querySelectorAll('[data-tab]')].map((t) => t.getAttribute('data-tab'))
  if (scenario === 'user') {
    assert('a User sees only My settings', sections.join(',') === 'My settings' && !tabs.includes('people') && !tabs.includes('label'))
    assert('with six tabs', tabs.join(',') === 'profile,signin,notifications,mailbox,theme,mynav')
    say('DONE'); globalThis.__DONE__ = true; return
  }
  assert('the rail has two groups: My settings and Label settings', sections.join(',') === 'My settings,Label settings')
  assert('the rail is a single left column, not stacked strips', !!host.querySelector('[data-settings-shell] aside') && host.querySelectorAll('[data-settings-shell] nav').length === 2)
  assert('the label group has People, Label, Integrations, Activity, Admin docs, Sandbox, Archive', ['people', 'label', 'integrations', 'activity', 'admin', 'sandbox', 'archive'].every((t) => tabs.includes(t)))
  assert('People and Activity are links to their own pages (paths unchanged)', host.querySelector('[data-tab="people"]')?.getAttribute('href') === '/team' && host.querySelector('[data-tab="activity"]')?.getAttribute('href') === '/activity')
  assert('Sandbox opens in a new window', host.querySelector('[data-tab="sandbox"]')?.getAttribute('href') === '/admin/vendor-lab' && host.querySelector('[data-tab="sandbox"]')?.getAttribute('target') === '_blank')
  assert('no Users or Permissions tab remains', !tabs.includes('users') && !tabs.includes('permissions'))

  say('\nPROFILE')
  const nameInput = host.querySelector('[data-tab-profile] input')
  type(nameInput, 'John S.'); host.querySelector('[data-tab-profile]').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await sleep(200)
  assert('saving PUTs /settings/me with the name', calls.put.some((c) => c.url === '/settings/me' && c.body.name === 'John S.'))

  say('\nSIGN-IN')
  click(host.querySelector('[data-tab="signin"]')); await sleep(200)
  const si = host.querySelector('[data-tab-signin]')
  assert('the Sign-in tab shows the change-password form and recent sign-ins', !!si && /Change password/.test(textOf(si)) && /Chrome · Mac/.test(textOf(si)) && !!si.querySelector('[data-signout-all]'))
  const pws = si.querySelectorAll('input[type="password"]'); type(pws[0], 'oldpass123'); type(pws[1], 'short'); type(pws[2], 'short')
  si.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await sleep(100)
  assert('a short new password is refused client-side', /at least 8/.test(textOf(si.querySelector('[data-signin-error]'))))

  say('\nNOTIFICATIONS')
  click(host.querySelector('[data-tab="notifications"]')); await sleep(200)
  const nt = host.querySelector('[data-tab-notifications]')
  assert('the tab says sending waits on a Team mailbox', /Team mailbox/.test(textOf(nt)) && nt.querySelector('[data-delivery]')?.getAttribute('data-delivery') === 'off')
  assert('saved prefs are reflected (payments due on)', nt.querySelector('[data-notify="payments_due"]')?.checked === true && nt.querySelector('[data-notify="tasks_assigned"]')?.checked === false)
  click(nt.querySelector('[data-notify="tasks_assigned"]')); await sleep(150)
  assert('toggling PUTs the whole set', calls.put.some((c) => c.url === '/settings/me/notifications' && c.body.tasks_assigned === true && c.body.payments_due === true))

  say('\nLABEL')
  click(host.querySelector('[data-tab="label"]')); await sleep(200)
  const lb = host.querySelector('[data-tab-label]')
  assert('the Label tab loads the record into fields', lb?.querySelector('[data-label-field="legal_name"]')?.value === 'Market Street Records LLC')
  assert('sections are cards with their own blank counts', host.querySelectorAll('[data-label-section]').length === 6 && /complete/.test(textOf(host.querySelector('[data-label-section="Identity"]'))) && /blank/.test(textOf(host.querySelector('[data-label-section="Address"]'))))
  const pv = host.querySelector('[data-label-preview]')
  assert('the live preview prints the legal name in caps and dashes for blanks', /MARKET STREET RECORDS LLC/.test(textOf(pv)) && /EIN: ••-•••6789/.test(textOf(pv)) && pv.querySelectorAll('.text-rose-400').length > 0)
  type(lb.querySelector('[data-label-field="bank_name"]'), 'Chase'); await sleep(50)
  assert('typing updates the preview as you go', /BANK: CHASE/.test(textOf(pv)))
  assert('secrets show status, not values: EIN ending 6789, account not on file', /ending 6789/.test(textOf(lb.querySelector('[data-secret-status="ein"]'))) && /not on file/.test(textOf(lb.querySelector('[data-secret-status="bank_account_number"]'))))
  assert('the status line counts the blanks', /still blank/.test(textOf(lb.querySelector('[data-label-status]'))))
  type(lb.querySelector('[data-secret-field="bank_account_number"]'), '000123456789')
  lb.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await sleep(250)
  const put = calls.put.find((c) => c.url === '/label')
  assert('saving PUTs the plain fields and the typed account number, never a stored one', !!put && put.body.legal_name === 'Market Street Records LLC' && put.body.bank_account_number === '000123456789' && !('ein' in put.body))
  assert('after saving, the account number field is cleared and status reads ending 6789', lb.querySelector('[data-secret-field="bank_account_number"]')?.value === '' && /ending 6789/.test(textOf(lb.querySelector('[data-secret-status="bank_account_number"]'))))

  say('\nINTEGRATIONS')
  click(host.querySelector('[data-tab="integrations"]')); await sleep(200)
  const it = host.querySelector('[data-tab-integrations]')
  assert('the QuickBooks and DocuSign cards render (unconnected, with the label signer line)', !!it?.querySelector('[data-quickbooks-card][data-connected="0"]') && !!it?.querySelector('[data-docusign-card][data-connected="0"]') && /no email yet/.test(it?.querySelector('[data-ds-signer]')?.textContent || ''))
  assert('integrations list status, what each powers, and a detail', it?.querySelector('[data-integration="gmail"]')?.getAttribute('data-configured') === '0' && it?.querySelector('[data-integration="storage"]')?.getAttribute('data-configured') === '1' && /bucket ms-files/.test(textOf(it)))
  assert('no key is rendered anywhere', !/[A-Za-z0-9]{32,}/.test(textOf(it)))
  assert('nothing threw', errors.length === 0)
  if (errors.length) say('  ' + errors.join('\n  '))
  say('DONE'); globalThis.__DONE__ = true
}
main()
