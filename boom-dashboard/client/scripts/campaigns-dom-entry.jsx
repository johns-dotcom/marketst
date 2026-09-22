// Song Campaigns under jsdom. Scenarios (CAMP_SCENARIO):
//   full   board by status · cards (bar, left, attention) · URL filters · drawer (checklist, confirm-with-note, lines, channels) · list · new
//   empty  the empty state alone
//   url    ?owner=me&attn=1&campaign=2 opens filtered with the drawer up
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import SongCampaigns from '../src/pages/SongCampaigns'
import { calls } from './campaigns-api-stub.js'
import { ThemeProvider } from '../src/context/ThemeContext'
import { ToastProvider } from '../src/context/ToastContext'

const errors = []
window.addEventListener('error', (e) => errors.push('window.error: ' + e.message))
console.error = (...a) => { const m = a.map(String).join(' '); if (/Warning:|Not implemented: navigation/.test(m)) return; errors.push('console.error: ' + m.slice(0, 300)) }
window.confirm = () => true
class Catch extends React.Component {
  constructor(p) { super(p); this.state = { err: null } }
  static getDerivedStateFromError(err) { return { err } }
  componentDidCatch(err) { errors.push('THROWN: ' + (err && err.message)); errors.push('STACK: ' + String(err?.stack || '').split('\n').slice(0, 4).join(' | ')) }
  render() { return this.state.err ? null : this.props.children }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const say = (...a) => console.log(...a)
const assert = (label, cond) => say(`  ${label} -> ${!!cond}`)
const textOf = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '')
const click = (el) => el && el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
const setInput = (el, v) => { const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new window.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })) }
const scenario = (typeof process !== 'undefined' && process.env.CAMP_SCENARIO) || 'full'
globalThis.__CAMP_SCENARIO__ = scenario
try { localStorage.clear() } catch { /* none */ }
let where = ''
function Where() { const loc = useLocation(); where = loc.pathname + loc.search; return null }

async function main() {
  say(`SCENARIO ${scenario}`)
  const host = document.createElement('div'); document.body.appendChild(host)
  const start = scenario === 'url' ? '/campaigns?owner=me&attn=1&campaign=2' : '/campaigns'
  createRoot(host).render(<Catch><ThemeProvider><ToastProvider><MemoryRouter initialEntries={[start]}><Where /><Routes><Route path="/campaigns" element={<SongCampaigns />} /></Routes></MemoryRouter></ToastProvider></ThemeProvider></Catch>)
  for (let i = 0; i < 60 && !host.querySelector('[data-campaigns-board]'); i += 1) await sleep(100)
  await sleep(300)
  if (errors.length) for (const e of errors) say('    EARLY ' + e)
  const cards = () => [...host.querySelectorAll('[data-campaign-card]')]
  const card = (id) => host.querySelector(`[data-campaign-card="${id}"]`)
  const drawer = () => host.querySelector('[data-campaign-drawer]')

  if (scenario === 'empty') {
    assert('an empty page shows the empty state and no columns', /No song campaigns yet/.test(textOf(host)) && host.querySelectorAll('[data-campaign-column]').length === 0 && !!host.querySelector('[data-tour="song-campaigns-new"]'))
  }
  if (scenario === 'url') {
    assert('?owner=me&attn=1 keeps only my campaigns needing attention (Slow Light: finished, unconfirmed)', cards().length === 1 && !!card(3) && host.querySelector('[data-campaigns-attn]')?.getAttribute('aria-pressed') === 'true')
    await sleep(300)
    assert('?campaign=2 opens the drawer on arrival', drawer()?.getAttribute('data-campaign-drawer') === '2')
  }
  if (scenario === 'full') {
    const cols = [...host.querySelectorAll('[data-campaign-column]')].map((c) => c.getAttribute('data-campaign-column'))
    assert('five lifecycle columns, one card each', cols.join(',') === 'planning,live,finished,ready,uploaded' && cards().length === 5)
    assert('the header totals open campaigns, budget, spent, committed, ready and attention', /4 open · \$11k budgeted · \$4.4k spent · \$500 committed · 1 ready for recoupment · 2 need attention/.test(textOf(host.querySelector('[data-tour="song-campaigns-header"]'))))
    assert('a card carries the budget bar, the owner initials and what is left', !!card(2).querySelector('[data-budget-bar]') && textOf(card(2).querySelector('[data-campaign-owner]')) === 'SC' && /\$500 over/.test(textOf(card(2).querySelector('[data-campaign-left]'))) && /\$3.8k left/.test(textOf(card(1).querySelector('[data-campaign-left]'))))
    assert('attention lines: over budget, finished-unconfirmed; the ready and uploaded cards have none', /Over budget/.test(textOf(card(2).querySelector('[data-campaign-attn]'))) && /confirm it ready/.test(textOf(card(3).querySelector('[data-campaign-attn]'))) && !card(4).querySelector('[data-campaign-attn]') && !card(5).querySelector('[data-campaign-attn]'))
    assert('the next-step button names the move: Go live · Spending finished · Confirm ready; none on ready or uploaded', /Go live/.test(textOf(card(1).querySelector('[data-campaign-next]'))) && /Spending finished/.test(textOf(card(2).querySelector('[data-campaign-next]'))) && /Confirm ready/.test(textOf(card(3).querySelector('[data-campaign-next]'))) && !card(4).querySelector('[data-campaign-next]'))
    // filters in the URL
    setInput(host.querySelector('[data-campaigns-owner]'), 'me'); await sleep(150)
    assert('Owner: Mine keeps mine and writes owner=me', /owner=me/.test(where) && cards().length === 4 && !card(2))
    click(host.querySelector('[data-campaigns-attn]')); await sleep(150)
    assert('Needs attention narrows further, in the URL (of mine, only Slow Light needs me)', /attn=1/.test(where) && cards().length === 1 && !!card(3))
    click(host.querySelector('[data-campaigns-clear]')); await sleep(150)
    assert('Clear resets', cards().length === 5 && !/owner=|attn=/.test(where))
    // confirm from a card: the checklist is clear → one click
    click(card(3).querySelector('[data-campaign-next]')); await sleep(250)
    assert('Confirm ready on a clear checklist POSTs status=ready and the card moves to Ready', calls.post.some((c) => c.url === '/campaigns/3/status' && c.body.status === 'ready') && !!host.querySelector('[data-campaign-column="ready"] [data-campaign-card="3"]'))
    // the drawer on the over-budget live campaign
    click(card(2).querySelector('[data-campaign-open]')); await sleep(400)
    const d = drawer()
    assert('the drawer opens with money, lifecycle, checklist, lines, channels, invoices, details and timeline', !!d && ['[data-campaign-money]', '[data-campaign-lifecycle]', '[data-campaign-checklist]', '[data-campaign-lines]', '[data-campaign-channels]', '[data-campaign-invoices]', '[data-campaign-details]', '[data-campaign-timeline]'].every((s) => d.querySelector(s)))
    assert('money reads budget · spent · committed · expected · left, with left negative', textOf(d.querySelector('[data-money="budget"]')) === '$3,000' && textOf(d.querySelector('[data-money="spent"]')) === '$2,000' && textOf(d.querySelector('[data-money="committed"]')) === '$500' && textOf(d.querySelector('[data-money="expected"]')) === '$1,000' && textOf(d.querySelector('[data-money="left"]')) === '-$500')
    assert('the checklist names the three gaps and reads not ready', d.querySelector('[data-campaign-checklist]')?.getAttribute('data-ready') === '0' && ['lines_in', 'all_paid', 'docs'].every((k) => d.querySelector(`[data-check="${k}"]`)?.getAttribute('data-ok') === '0'))
    assert('expected lines show two in, one open, with a link button on the open one', d.querySelectorAll('[data-campaign-line]').length === 3 && d.querySelectorAll('[data-line-in="1"]').length === 2 && !!d.querySelector('[data-campaign-line="203"] [data-line-link]'))
    click(d.querySelector('[data-campaign-line="203"] [data-line-link]')); await sleep(100)
    assert('linking lists only the invoices on this song not yet linked (Creator X)', d.querySelectorAll('[data-link-invoice]').length === 1 && /Creator X/.test(textOf(d.querySelector('[data-campaign-link-menu]'))))
    click(d.querySelector('[data-link-invoice="13"]')); await sleep(200)
    assert('picking one PUTs expense_id on the line and it ticks', calls.put.some((c) => c.url === '/campaigns/2/lines/203' && c.body.expense_id === 13) && d.querySelector('[data-campaign-line="203"]')?.getAttribute('data-line-in') === '1')
    assert('spend by channel lists Advertisements and Marketing with paid and unpaid', /Advertisements/.test(textOf(d.querySelector('[data-channel="Advertisements"]'))) && /\$800 \+ \$500 unpaid/.test(textOf(d.querySelector('[data-channel="Marketing"]'))))
    // finish, then confirm with a note (the checklist is not clear)
    click(d.querySelector('[data-campaign-move="finished"]')); await sleep(250)
    assert('Spending finished moves it and offers Confirm ready anyway…', calls.post.some((c) => c.url === '/campaigns/2/status' && c.body.status === 'finished') && !!d.querySelector('[data-campaign-confirm-anyway]'))
    click(d.querySelector('[data-campaign-confirm-anyway]')); await sleep(100)
    const form = d.querySelector('[data-campaign-confirm-form]')
    assert('…which opens the note form with the submit disabled until a reason is typed', !!form && form.querySelector('[data-campaign-confirm-submit]').disabled)
    setInput(form.querySelector('[data-campaign-confirm-note]'), 'creator invoice arrives Friday'); form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await sleep(300)
    const conf = calls.post.find((c) => c.url === '/campaigns/2/status' && c.body.status === 'ready')
    assert('the confirmation POSTs status=ready with the note and the drawer reads Ready with it', !!conf && conf.body.note === 'creator invoice arrives Friday' && /Ready for recoupment/.test(textOf(d)) && /arrives Friday/.test(textOf(d.querySelector('[data-campaign-ready-note]'))))
    click(d.querySelector('[data-campaign-reopen]')); await sleep(250)
    assert('Reopen posts status=live', calls.post.some((c) => c.url === '/campaigns/2/status' && c.body.status === 'live'))
    setInput(d.querySelector('[data-campaign-note-input]'), 'creative approved'); d.querySelector('[data-campaign-note-input]').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await sleep(200)
    assert('Enter posts a timeline note', calls.post.some((c) => c.url === '/campaigns/2/events' && c.body.body === 'creative approved'))
    click(d.querySelector('button[aria-label="Close"]')); await sleep(150)
    assert('closing drops ?campaign= from the URL', !drawer() && !/campaign=/.test(where))
    // list view
    click(host.querySelector('[data-campaigns-view="list"]')); await sleep(200)
    assert('the list view renders every campaign as a row with view=list in the URL', host.querySelectorAll('[data-campaign-row]').length === 5 && /view=list/.test(where))
    click(host.querySelector('[data-campaigns-view="board"]')); await sleep(150)
    // new campaign
    click(host.querySelector('[data-tour="song-campaigns-new"]')); await sleep(150)
    const nf = host.querySelector('[data-campaign-form]')
    assert('New campaign offers artist, song, budget, owner, dates and expected lines', !!nf && !!nf.querySelector('[data-campaign-song]') && !!nf.querySelector('[data-campaign-budget]') && !!nf.querySelector('[data-campaign-owner-select]') && !!nf.querySelector('[data-line-label]'))
    // the artist picker (PickerMenu): a button reading the placeholder opens a menu with a filter box; an option row commits
    click([...nf.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Artist…')); await sleep(150)
    const filter = [...document.querySelectorAll('input')].find((i) => /Type to filter/.test(i.placeholder || ''))
    if (filter) { setInput(filter, 'New Prospect'); await sleep(150) }
    const opt = [...document.querySelectorAll('button, li, div')].find((x) => x.children.length === 0 && (x.textContent || '').trim() === 'New Prospect' && x !== filter)
    if (opt) { opt.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true })); click(opt) }
    await sleep(120)
    setInput(nf.querySelector('[data-campaign-song]'), 'First Single'); setInput(nf.querySelector('[data-campaign-budget]'), '2500'); setInput(nf.querySelector('[data-line-label]'), 'TikTok creators'); setInput(nf.querySelector('[data-line-amount]'), '1500')
    nf.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await sleep(300)
    const post = calls.post.find((c) => c.url === '/campaigns')
    assert('Create POSTs artist, song, budget and the expected line, then opens the new campaign', !!post && post.body.song === 'First Single' && post.body.budget === 2500 && post.body.lines[0]?.label === 'TikTok creators' && (post.body.artist === 'New Prospect' || post.body.artist.length > 0) && drawer()?.getAttribute('data-campaign-drawer') === '50')
  }
  assert('no errors during render', errors.length === 0)
  if (errors.length) for (const e of errors) say('    ' + e)
  say('DONE')
}
main()
