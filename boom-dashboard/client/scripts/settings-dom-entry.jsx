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
import { NAV_PAGES } from '../src/navConfig'
import { PRESETS } from '../src/lib/navPresets'
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
const setValue = (el, v) => { Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new window.Event('change', { bubbles: true })) }
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
    assert('with four tabs — theme folded into Profile, the mailbox into Notifications & mail', tabs.join(',') === 'profile,signin,notifications,mynav')
    // A User who accepted the invite by signing in with Google: no password yet.
    click(host.querySelector('[data-tab="signin"]')); await sleep(250)
    const pf = host.querySelector('[data-password-form]')
    assert('the Sign-in tab offers SET a password — no current-password box — and says why', pf?.getAttribute('data-password-form') === 'set' && !pf.querySelector('input[autocomplete="current-password"]') && /signed in with Google/.test(textOf(pf.querySelector('[data-set-password-why]'))) && /Set password/.test(textOf(pf.querySelector('[data-password-submit]'))))
    const [n1, n2] = [...pf.querySelectorAll('input[type="password"]')]
    click(pf.querySelector('[data-password-toggle]')); await sleep(60)
    assert('the eye shows the password as text, and again hides it', n1.getAttribute('type') === 'text' && (click(pf.querySelector('[data-password-toggle]')), true))
    await sleep(60)
    type(n1, 'correct-horse-battery'); type(n2, 'correct-horse-battery'); pf.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await sleep(250)
    const cp = calls.post.find((c) => c.url === '/auth/change-password')
    assert('setting it POSTs only the new password, and the form becomes Change password', !!cp && cp.body.current_password === undefined && cp.body.new_password === 'correct-horse-battery' && host.querySelector('[data-password-form]')?.getAttribute('data-password-form') === 'change' && /Password set/.test(textOf(host.querySelector('[data-signin-note]'))))
    say('DONE'); globalThis.__DONE__ = true; return
  }
  assert('the rail has two groups: My settings and Label settings', sections.join(',') === 'My settings,Label settings')
  assert('the rail is a single left column, not stacked strips', !!host.querySelector('[data-settings-shell] aside') && host.querySelectorAll('[data-settings-shell] nav').length === 2)
  assert('the label group is People, Roles & teams, Label, Integrations, Activity, Admin docs — in that order', tabs.slice(4).join(',') === 'people,roles,label,integrations,activity,admin')
  assert('Navs, Archive and Sandbox left the rail (folded, not deleted)', !tabs.includes('navs') && !tabs.includes('archive') && !tabs.includes('sandbox'))
  assert('Profile carries the theme section', !!host.querySelector('[data-fold="theme"] [data-theme-option="dark"]'))
  assert('People and Activity are links to their own pages (paths unchanged)', host.querySelector('[data-tab="people"]')?.getAttribute('href') === '/team' && host.querySelector('[data-tab="activity"]')?.getAttribute('href') === '/activity')
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
  assert('My mailbox sits below on the same tab', !!host.querySelector('[data-fold="mailbox"] [data-my-mailbox]'))

  say('\nLABEL')
  click(host.querySelector('[data-tab="label"]')); await sleep(200)
  const lb = host.querySelector('[data-tab-label]')
  assert('the Label tab loads the record into fields', lb?.querySelector('[data-label-field="legal_name"]')?.value === 'market.st Records LLC')
  assert('sections are cards with their own blank counts', host.querySelectorAll('[data-label-section]').length === 7 && /complete/.test(textOf(host.querySelector('[data-label-section="Identity"]'))) && /blank/.test(textOf(host.querySelector('[data-label-section="Address"]'))))
  const pv = host.querySelector('[data-label-preview]')
  assert('the live preview prints the legal name in caps and dashes for blanks', /MARKET.ST RECORDS LLC/.test(textOf(pv)) && /EIN: ••-•••6789/.test(textOf(pv)) && pv.querySelectorAll('.text-rose-400').length > 0)
  type(lb.querySelector('[data-label-field="bank_name"]'), 'Chase'); await sleep(50)
  assert('typing updates the preview as you go', /BANK: CHASE/.test(textOf(pv)))
  assert('secrets show status, not values: EIN ending 6789, account not on file', /ending 6789/.test(textOf(lb.querySelector('[data-secret-status="ein"]'))) && /not on file/.test(textOf(lb.querySelector('[data-secret-status="bank_account_number"]'))))
  assert('the status line counts the blanks', /still blank/.test(textOf(lb.querySelector('[data-label-status]'))))
  type(lb.querySelector('[data-secret-field="bank_account_number"]'), '000123456789')
  lb.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await sleep(250)
  const put = calls.put.find((c) => c.url === '/label')
  assert('saving PUTs the plain fields and the typed account number, never a stored one', !!put && put.body.legal_name === 'market.st Records LLC' && put.body.bank_account_number === '000123456789' && !('ein' in put.body))
  assert('after saving, the account number field is cleared and status reads ending 6789', lb.querySelector('[data-secret-field="bank_account_number"]')?.value === '' && /ending 6789/.test(textOf(lb.querySelector('[data-secret-status="bank_account_number"]'))))
  assert('the full export sits at the foot of Label for a Superadmin', /Full Archive Export/.test(textOf(host.querySelector('[data-fold="export"]'))))

  say('\nINTEGRATIONS')
  click(host.querySelector('[data-tab="integrations"]')); await sleep(200)
  const it = host.querySelector('[data-tab-integrations]')
  assert('the QuickBooks and DocuSign cards render (unconnected, with the label signer line)', !!it?.querySelector('[data-quickbooks-card][data-connected="0"]') && !!it?.querySelector('[data-docusign-card][data-connected="0"]') && /no email yet/.test(it?.querySelector('[data-ds-signer]')?.textContent || ''))
  assert('integrations list status, what each powers, and a detail', it?.querySelector('[data-integration="gmail"]')?.getAttribute('data-configured') === '0' && it?.querySelector('[data-integration="storage"]')?.getAttribute('data-configured') === '1' && /bucket ms-files/.test(textOf(it)))
  assert('no key is rendered anywhere', !/[A-Za-z0-9]{32,}/.test(textOf(it)))
  assert('the vendor-form sandbox is a link inside Integrations, opening in a new window', it?.querySelector('[data-sandbox-link] a')?.getAttribute('href') === '/admin/vendor-lab' && it?.querySelector('[data-sandbox-link] a')?.getAttribute('target') === '_blank')
  // ── Roles & teams: roles, and teams with their page bundles, as editable data ──
  click(host.querySelector('[data-tab="roles"]')); await sleep(250)
  const oe = host.querySelector('[data-org-editor]')
  assert('the page is flat cards: How access actually works (folded) · Permissions · Teams · Department navs (folded)', [...oe.querySelectorAll('[data-org-section]')].map((c) => `${c.getAttribute('data-org-section')}:${c.getAttribute('data-open')}`).join(',') === 'roles:0,permissions:1,teams:1,navs:0')
  const pm = oe.querySelector('[data-permissions]')
  assert('Permissions lists every member with role, department and access, and Configure opens their Access tab', pm?.querySelectorAll('[data-perm-row]').length === 3 && /Full access/.test(textOf(pm.querySelector('[data-perm-row="1"] [data-perm-access]'))) && new RegExp(`${BOOKKEEPER_PAGES.length} pages`).test(textOf(pm.querySelector('[data-perm-row="2"] [data-perm-access]'))) && pm.querySelector('[data-perm-configure="2"]')?.getAttribute('href') === '/team/2' && pm.querySelectorAll('[data-perm-select] option').length === 4)
  // Folding one card must not remount the others (Card is module-level): before
  // that, Permissions refetched the directory on every toggle and a save's note
  // was wiped by the refresh that follows it.
  const peopleReads = () => calls.get.filter((u) => u === '/settings/people').length
  const readsBefore = peopleReads()
  click(oe.querySelector('[data-org-toggle="teams"]')); await sleep(120)
  click(oe.querySelector('[data-org-toggle="teams"]')); await sleep(120)
  assert('folding another card leaves Permissions mounted — no refetch of the directory', peopleReads() === readsBefore && oe.querySelectorAll('[data-perm-row]').length === 3)
  click(oe.querySelector('[data-org-toggle="roles"]')); await sleep(150)
  assert('the Roles & teams tab renders the editor with its sections and the four base roles', !!oe && ['roles', 'teams', 'navs'].every((k) => oe.querySelector(`[data-org-section="${k}"]`)) && oe.querySelectorAll('[data-role-card]').length === 4 && oe.querySelector('[data-role-card="Admin"]')?.getAttribute('data-builtin') === '1')
  click(oe.querySelector('[data-role-new]')); await sleep(100)
  const rf = oe.querySelector('[data-role-form="new"]')
  type(rf.querySelector('[data-role-label]'), 'Bookkeeper'); setValue(rf.querySelector('[data-role-base]'), 'Approver'); type(rf.querySelector('[data-role-short]'), 'Approves and pays, no people'); click(rf.querySelector('[data-role-preset="bookkeeper"]')); await sleep(40); rf.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await sleep(250)
  const rp = calls.post.find((c) => c.url === '/settings/org/roles')
  assert('a new role POSTs its name, base tier, description and starting presets', !!rp && rp.body.label === 'Bookkeeper' && rp.body.base_role === 'Approver' && rp.body.presets.includes('bookkeeper'))
  assert('…and the confirmation survives the refresh that follows the save', /Created Bookkeeper/.test(textOf(oe.querySelector('[data-org-section="roles"] [data-org-note]'))))
  // ── Teams: the department row carries the pages it starts people with ──
  // The count the row prints is NAV_PAGES ∩ the bundle — the same walk the card does.
  const MARKETING_PAGES = NAV_PAGES.filter((p) => (PRESETS.find((x) => x.key === 'marketing')?.paths || []).includes(p.path)).length
  const team = (n) => oe.querySelector(`[data-department-row="${n}"]`)
  assert('Teams lists the five departments with people counts, the pages each starts with, and a sorts-first badge on the lowest level', oe.querySelectorAll('[data-department-row]').length === 5 && /2 people/.test(textOf(team('Marketing')?.querySelector('[data-department-members]'))) && !!team('Executive')?.querySelector('[data-department-first]') && !team('Marketing')?.querySelector('[data-department-first]'))
  assert('…the pages line counts the bundle, and reads Every page for Operations', new RegExp(`^${MARKETING_PAGES} pages — `).test(textOf(team('Marketing').querySelector('[data-department-pages]'))) && /^Every page/.test(textOf(team('Operations').querySelector('[data-department-pages]'))))
  assert('presets are no longer a second list of the same thing — every bundle is a team default, so no extras render', !oe.querySelector('[data-extra-bundles]') && oe.querySelectorAll('[data-preset-row]').length === 0)
  // editing a team edits the bundle's pages in the same form
  click(team('Marketing').querySelector('[data-department-edit="Marketing"]')); await sleep(150)
  const mf = oe.querySelector('[data-department-form="Marketing"]')
  assert('the team form opens on its bundle with the pages ticked', !!mf && !!mf.querySelector('[data-team-pages]') && mf.querySelector('[data-nav-page="/campaigns"] [data-nav-grant]')?.checked === true)
  click(mf.querySelector('[data-nav-page="/deals"] [data-nav-grant]')); await sleep(40)
  mf.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await sleep(300)
  const bundlePut = calls.put.find((c) => c.url === '/settings/org/presets/marketing')
  const deptPut = calls.put.find((c) => c.url === '/settings/org/departments/Marketing')
  assert('saving the team writes the bundle\'s pages AND the team, in that order', !!bundlePut && bundlePut.body.paths.includes('/deals') && bundlePut.body.paths.includes('/campaigns') && !!deptPut && deptPut.body.presets.includes('marketing'))
  // a new team can be given its own page set, created as a bundle in the same save
  type(oe.querySelector('[data-department-draft]'), 'Publishing')
  click(oe.querySelector('[data-department-new]')); await sleep(150)
  const df = oe.querySelector('[data-department-form="new"]')
  type(df.querySelector('[data-department-name]'), 'Publishing'); type(df.querySelector('[data-department-level]'), '3')
  click(df.querySelector('[data-department-own]')); await sleep(60)
  click(df.querySelector('[data-nav-page="/releases"] [data-nav-grant]')); click(df.querySelector('[data-nav-page="/catalog"] [data-nav-grant]')); await sleep(40)
  df.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await sleep(300)
  const pp = calls.post.find((c) => c.url === '/settings/org/presets')
  const dp = calls.post.find((c) => c.url === '/settings/org/departments')
  assert('its own page set POSTs as a bundle named after the team', !!pp && pp.body.label === 'Publishing' && pp.body.paths.includes('/releases') && pp.body.paths.includes('/catalog') && pp.body.paths.length === 2)
  assert('and the team POSTs with that bundle, its name and level', !!dp && dp.body.name === 'Publishing' && dp.body.default_level === 3 && dp.body.presets.includes('publishing'))
  // ── My Nav saves to the ACCOUNT ──
  click(host.querySelector('[data-tab="mynav"]')); await sleep(200)
  const mn = host.querySelector('[data-mynav]')
  assert('My Nav renders the shared grid over the pages this person can open', !!mn && mn.querySelectorAll('[data-nav-page]').length > 5)
  click(mn.querySelector('[data-nav-page="/calendar"] [data-nav-show]')); await sleep(150)
  assert('unticking a page PUTs nav_hidden to /settings/me (not localStorage alone)', calls.put.some((c) => c.url === '/settings/me' && JSON.stringify(c.body.nav_hidden) === '["/calendar"]'))
  // ── Department navs (Superadmin) — inside Roles & teams since 2026-09-22 ──
  click(host.querySelector('[data-tab="roles"]')); await sleep(250)
  click(host.querySelector('[data-org-toggle="navs"]')); await sleep(300)
  const dn = host.querySelector('[data-org-section="navs"] [data-department-navs]')
  const chip = (d) => [...dn.querySelectorAll('[data-dept]')].find((b) => b.getAttribute('data-dept') === d)   // an & in a CSS attribute selector trips jsdom
  assert('the Department navs section lists the departments, marking which are saved', !!dn && chip('Marketing')?.getAttribute('data-saved') === '1' && chip('A&R')?.getAttribute('data-saved') === '0')
  click(chip('Marketing')); await sleep(200)
  assert('the saved Marketing nav loads: /campaigns granted and shown, /messages granted but off the sidebar, /deals not in the nav', dn.querySelector('[data-nav-page="/campaigns"]')?.getAttribute('data-granted') === '1' && dn.querySelector('[data-nav-page="/campaigns"]')?.getAttribute('data-shown') === '1' && dn.querySelector('[data-nav-page="/messages"]')?.getAttribute('data-shown') === '0' && dn.querySelector('[data-nav-page="/deals"]')?.getAttribute('data-granted') === '0')
  assert('members are listed, with who customised their own sidebar', /Rosa Lind · own sidebar/.test(textOf(dn.querySelector('[data-navs-members]'))) && /Dev Patel/.test(textOf(dn.querySelector('[data-navs-members]'))) && !!dn.querySelector('[data-navs-force]'))
  click(dn.querySelector('[data-nav-page="/deals"] [data-nav-grant]')); await sleep(100)
  click(dn.querySelector('[data-navs-save]')); await sleep(300)
  const navPut = calls.put.find((c) => /\/settings\/department-navs\/Marketing/.test(c.url))
  assert('Save PUTs the page list with /deals added, hidden kept, apply on — and reports what happened', !!navPut && navPut.body.pages.includes('/deals') && navPut.body.hidden.includes('/messages') && navPut.body.apply === true && /applied to 1 member/.test(textOf(dn.querySelector('[data-navs-note]'))) && /1 kept their own sidebar/.test(textOf(dn.querySelector('[data-navs-note]'))))
  click(chip('A&R')); await sleep(200)
  assert('an unsaved department starts from its code preset (A&R has /artists, not /bk/approvals)', dn.querySelector('[data-nav-page="/artists"]')?.getAttribute('data-granted') === '1' && dn.querySelector('[data-nav-page="/bk/approvals"]')?.getAttribute('data-granted') === '0')
  // ── A folded tab's old ?tab= id lands ON the section, not above it ──
  const deep = mount('/settings?tab=navs', <Route path="/settings" element={<SettingsShell><Settings /></SettingsShell>} />)
  await sleep(500)
  assert('?tab=navs redirects to Roles & teams AND unfolds the Department navs card', deep.querySelector('[data-settings-content]')?.getAttribute('data-settings-content') === 'roles' && deep.querySelector('[data-org-section="navs"]')?.getAttribute('data-open') === '1' && deep.querySelector('[data-org-section="roles"]')?.getAttribute('data-open') === '0')
  const deep2 = mount('/settings?tab=roles#roles', <Route path="/settings" element={<SettingsShell><Settings /></SettingsShell>} />)
  await sleep(500)
  assert('…and #roles (the person form\'s "All roles compared") unfolds the roles card', deep2.querySelector('[data-org-section="roles"]')?.getAttribute('data-open') === '1')
  assert('nothing threw', errors.length === 0)
  if (errors.length) say('  ' + errors.join('\n  '))
  say('DONE'); globalThis.__DONE__ = true
}
main()
