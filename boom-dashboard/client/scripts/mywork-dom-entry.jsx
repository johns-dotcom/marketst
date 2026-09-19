// My Work — the one-list page, under jsdom.
// Scenarios (MW_SCENARIO env): full · empty
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import MyWork from '../src/pages/MyWork'
import { calls } from './mywork-api-stub.js'
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
const click = (el) => el && el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
const type = (el, text) => { setter.call(el, text); el.dispatchEvent(new window.Event('input', { bubbles: true })) }
const scenario = (typeof process !== 'undefined' && process.env.MW_SCENARIO) || 'full'
globalThis.__MW_SCENARIO__ = scenario

async function main() {
  say(`SCENARIO ${scenario}`)
  const host = document.createElement('div'); document.body.appendChild(host)
  createRoot(host).render(<Catch><ThemeProvider><ToastProvider><MemoryRouter initialEntries={['/my-work']}><Routes><Route path="/my-work" element={<MyWork />} /></Routes></MemoryRouter></ToastProvider></ThemeProvider></Catch>)
  for (let i = 0; i < 50 && !host.querySelector('[data-task-list]'); i += 1) await sleep(100)
  await sleep(200)
  assert('the page rendered', errors.length === 0 && !!host.querySelector('[data-task-list]'))
  if (errors.length) say('  ' + errors.join('\n  '))
  assert('the header is My Work, not a greeting', textOf(host.querySelector('h1')) === 'My Work')
  if (scenario === 'empty') {
    assert('the summary says 0 open', /0 open/.test(textOf(host)))
    assert('the list shows the empty state', /Nothing open/.test(textOf(host.querySelector('[data-task-list]'))))
    const w = host.querySelector('[data-waiting]')
    assert('Waiting on you is hidden when there is nothing (the statement cutoff may stand alone within 7 days of the 20th)', !w || (w.querySelectorAll('[data-waiting-item]').length === 1 && /Statement cutoff/.test(textOf(w))))
    say('DONE'); globalThis.__DONE__ = true; return
  }
  assert('the summary counts open, due today and overdue', /4 open · 1 due today · 1 overdue/.test(textOf(host)))
  const buckets = [...host.querySelectorAll('[data-bucket]')].map((b) => b.getAttribute('data-bucket'))
  assert('open tasks are grouped Overdue · Today · This week · No date', buckets.join(',') === 'overdue,today,week,nodate')
  assert('a task assigned by someone else says who', /from Sam/.test(textOf(host.querySelector('[data-task="1"]'))))
  assert('done tasks are folded behind a count', /1 done/.test(textOf(host.querySelector('[data-toggle-done]'))) && !host.querySelector('[data-task="5"]'))
  click(host.querySelector('[data-task="3"] [data-task-open]')); await sleep(100)
  assert('clicking a row expands it in place', host.querySelector('[data-task="3"]')?.getAttribute('data-expanded') === '1' && !!host.querySelector('[data-task="3"] [data-task-detail]'))
  const sel = host.querySelector('[data-task="3"] [data-task-detail] select'); sel.value = 'In Progress'; sel.dispatchEvent(new window.Event('change', { bubbles: true })); await sleep(100)
  assert('changing status PUTs the task', calls.put.some((c) => c.url === '/team/tasks/3' && c.body.status === 'In Progress'))
  click(host.querySelector('[data-task="2"] [data-task-toggle]')); await sleep(100)
  assert('the circle marks a task done', calls.put.some((c) => c.url === '/team/tasks/2' && c.body.status === 'Done'))
  type(host.querySelector('[data-composer-input]'), 'Call the studio @'); await sleep(30)
  type(host.querySelector('[data-composer-input]'), 'Call the studio @sam'); await sleep(50)
  assert('@ opens the team menu filtered by what follows', /Sam Chen/.test(textOf(host.querySelector('[data-mention-menu]'))) && !/Rosa/.test(textOf(host.querySelector('[data-mention-menu]'))))
  host.querySelector('[data-mention-menu] button').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true })); await sleep(50)
  assert('picking assigns the task and strips the @', /Sam Chen/.test(textOf(host.querySelector('[data-composer-assignee]'))) && host.querySelector('[data-composer-input]').value === 'Call the studio')
  host.querySelector('[data-composer]').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await sleep(200)
  const post = calls.post.find((c) => c.url === '/team/tasks')
  assert('Add POSTs the task for Sam', !!post && post.body.user_id === 2 && post.body.description === 'Call the studio')
  const agenda = host.querySelector('[data-agenda]')
  const types = [...agenda.querySelectorAll('[data-agenda-event]')].map((e) => e.getAttribute('data-agenda-event'))
  assert("This week, mine: my deadline, MY release, the payment due — not Sam's task, not the other release", types.join(',') === 'deadline,release,payment_due' && !/Not mine|Sam's task/.test(textOf(agenda)))
  const waiting = host.querySelector('[data-waiting]')
  assert('Waiting on you: approvals, the mention, the unused invite', !!waiting && /3 invoices awaiting approval/.test(textOf(waiting)) && /1 unread mention/.test(textOf(waiting)) && /1 invite you sent/.test(textOf(waiting)) && /Rosa Lind/.test(textOf(waiting)))
  assert('each item links to its page', [...waiting.querySelectorAll('a')].map((a) => a.getAttribute('href')).includes('/bk/approvals'))
  assert('nothing threw', errors.length === 0)
  if (errors.length) say('  ' + errors.join('\n  '))
  say('DONE'); globalThis.__DONE__ = true
}
main()
