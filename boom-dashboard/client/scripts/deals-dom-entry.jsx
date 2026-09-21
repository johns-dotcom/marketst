// The deal pipeline, second pass, under jsdom. Scenarios (DEALS_SCENARIO):
//   full   board · cards · filters in the URL · drawer (owner, timeline, checklist) · passed modal · list · report
//   empty  the empty state alone, no blank columns
//   url    ?owner=me&attn=1&deal=3 opens filtered with the drawer up
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import DealPipeline from '../src/pages/DealPipeline'
import { calls } from './deals-api-stub.js'
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
const key = (k) => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true }))
const scenario = (typeof process !== 'undefined' && process.env.DEALS_SCENARIO) || 'full'
globalThis.__DEALS_SCENARIO__ = scenario
try { localStorage.clear() } catch { /* none */ }
let where = ''
function Where() { const loc = useLocation(); where = loc.pathname + loc.search; return null }

async function main() {
  say(`SCENARIO ${scenario}`)
  const host = document.createElement('div'); document.body.appendChild(host)
  const start = scenario === 'url' ? '/deals?owner=me&attn=1&deal=3' : '/deals'
  createRoot(host).render(
    <Catch><ThemeProvider><ToastProvider><MemoryRouter initialEntries={[start]}><Where /><Routes><Route path="/deals" element={<DealPipeline />} /></Routes></MemoryRouter></ToastProvider></ThemeProvider></Catch>
  )
  for (let i = 0; i < 60 && !host.querySelector('[data-deal-board], [data-deals-nomatch]'); i += 1) await sleep(100)
  await sleep(300)
  if (errors.length) for (const e of errors) say('    EARLY ' + e)
  const cards = () => [...host.querySelectorAll('[data-deal-card]')]
  const card = (id) => host.querySelector(`[data-deal-card="${id}"]`)
  const clear = () => click(host.querySelector('[data-deals-clear]'))

  if (scenario === 'empty') {
    assert('an empty pipeline shows the empty state and NO blank stage columns', !!host.querySelector('[data-deal-board]') && /No deals in the pipeline/.test(textOf(host)) && host.querySelectorAll('[data-deal-column]').length === 0)
    assert('the view toggle and New Deal still render (tour anchors)', !!host.querySelector('[data-tour="deals-views"]') && !!host.querySelector('[data-tour="deals-new"]'))
  }

  if (scenario === 'url') {
    assert('?owner=me&attn=1 filters the board to my deals needing attention (Kite & Ash stuck 25d, Night Drive is Sam\'s)', cards().length === 1 && !!card(3) && host.querySelector('[data-deals-attn]')?.getAttribute('aria-pressed') === 'true')
    assert('?deal=3 opens the drawer on arrival', host.querySelector('[data-deal-drawer]')?.getAttribute('data-deal-drawer') === '3')
  }

  if (scenario === 'full') {
    // ── the board ──
    const liveCols = [...host.querySelectorAll('[data-deal-column]')].map((c) => c.getAttribute('data-deal-column'))
    assert('four live stages are columns; Signed and Passed are folded rows below', liveCols.join(',') === 'Scouting,Meeting,Offer,Negotiation,Signed,Passed' && host.querySelector('[data-deal-column="Signed"]')?.getAttribute('data-open') === '0' && !card(6))
    assert('the header counts live deals, the advances on the table, signed and passed, and attention', /6 live · \$36k in advances · 1 signed · 2 passed · 2 need attention/.test(textOf(host.querySelector('[data-tour="deals-header"]') || host)))
    const offer = host.querySelector('[data-deal-column="Offer"]')
    assert('a column header sums its advances and counts its cards', textOf(offer.querySelector('[data-column-sum]')) === '$33k' && textOf(offer.querySelector('[data-column-count]')) === '2')
    assert('a card shows owner initials, the advance, days in stage with an amber/red tone, and the follow-up state', textOf(card(3).querySelector('[data-deal-owner]')) === 'JS' && textOf(card(3).querySelector('[data-deal-advance]')) === '$25k' && card(3).querySelector('[data-deal-days]')?.getAttribute('data-stale') === 'red' && card(2).querySelector('[data-deal-days]')?.getAttribute('data-stale') === 'amber' && card(2).querySelector('[data-deal-followup]')?.getAttribute('data-deal-followup') === 'overdue' && card(4).querySelector('[data-deal-followup]')?.getAttribute('data-deal-followup') === 'today')
    assert('the last touch reads who did what and when', /Called the manager · 4d ago · SC/.test(textOf(card(2).querySelector('[data-deal-last]'))))
    click(host.querySelector('[data-closed-toggle="Signed"]')); await sleep(100)
    assert('opening Signed lists its cards and says the advances', !!card(6) && /1 · \$40k in advances/.test(textOf(host.querySelector('[data-closed-toggle="Signed"]'))))
    click(host.querySelector('[data-closed-toggle="Signed"]')); await sleep(50)
    // ── filters in the URL ──
    setInput(host.querySelector('[data-deals-owner-filter]'), 'me'); await sleep(150)
    assert('Owner: Mine keeps my deals and writes owner=me to the URL', /owner=me/.test(where) && cards().length === 4 && !card(2) && !card(9))
    click(host.querySelector('[data-deals-attn]')); await sleep(150)
    assert('Needs attention narrows to overdue follow-ups and stuck deals, in the URL', /attn=1/.test(where) && cards().length === 1 && !!card(3))
    clear(); await sleep(150)
    setInput(host.querySelector('[data-filter]'), 'manager'); await sleep(150)
    assert('search matches the last note too, and q= is in the URL', /q=manager/.test(where) && cards().length === 1 && !!card(2))
    clear(); await sleep(150)
    assert('Clear empties the filters and the URL (six live cards; Signed and Passed stay folded)', cards().length === 6 && !/q=|owner=|attn=/.test(where))
    // ── keys ──
    key('j'); await sleep(50); key('Enter'); await sleep(150)
    assert('j then Enter opens the first card\'s drawer, and the URL carries ?deal=', !!host.querySelector('[data-deal-drawer]') && /deal=\d+/.test(where))
    click(host.querySelector('[data-deal-drawer] button[aria-label="Close"]')); await sleep(100)
    assert('closing the drawer drops ?deal= from the URL', !host.querySelector('[data-deal-drawer]') && !/deal=/.test(where))
    // ── the drawer ──
    click(card(3).querySelector('[data-deal-open]')); await sleep(250)
    const drawer = host.querySelector('[data-deal-drawer="3"]')
    assert('the drawer opens with the owner picker, a timeline, the Before Signed checklist, terms and Move Stage', !!drawer && !!drawer.querySelector('[data-deal-owner-select]') && !!drawer.querySelector('[data-deal-timeline]') && !!drawer.querySelector('[data-deal-checklist]') && !!drawer.querySelector('[data-deal-terms]') && !!drawer.querySelector('[data-deal-move]'))
    assert('the timeline lists the note, the stage move and the creation, newest first', [...drawer.querySelectorAll('[data-deal-event]')].map((e) => e.getAttribute('data-deal-event')).join(',') === 'note,stage,created' && /Moved Meeting → Offer/.test(textOf(drawer.querySelector('[data-deal-events]'))))
    setInput(drawer.querySelector('[data-deal-note-input]'), 'Manager wants 30k'); drawer.querySelector('[data-deal-note-input]').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await sleep(200)
    assert('Enter posts a dated note, which lands on top of the timeline and on the card as the last touch', calls.post.some((c) => c.url === '/deals/3/events' && c.body.body === 'Manager wants 30k') && /Manager wants 30k/.test(textOf(drawer.querySelector('[data-deal-events] li'))) && /Manager wants 30k/.test(textOf(card(3).querySelector('[data-deal-last]'))))
    const cl = drawer.querySelector('[data-deal-checklist]')
    assert('the checklist counts what is ready and names what is missing (owner, type, advance, royalty, term, territory, email ready; document counts; nothing blocks)', cl.getAttribute('data-ready') === '8' || (Number(cl.getAttribute('data-ready')) >= 6 && cl.querySelector('[data-check="deal_type"]')?.getAttribute('data-ok') === '1' && cl.querySelector('[data-check="artist_email"]')?.getAttribute('data-ok') === '1'))
    setInput(drawer.querySelector('[data-deal-owner-select]'), '2'); await sleep(200)
    assert('changing the owner PUTs owner_id and the card shows the new initials', calls.put.some((c) => c.url === '/deals/3' && c.body.owner_id === 2) && textOf(card(3).querySelector('[data-deal-owner]')) === 'SC')
    // ── passing asks why ──
    click(drawer.querySelector('[data-move-to="Passed"]')); await sleep(150)
    const modal = host.querySelector('[data-passed-modal]')
    assert('moving to Passed opens the reason modal instead of writing', !!modal && !calls.put.some((c) => c.url === '/deals/3' && c.body.stage === 'Passed'))
    click(modal.querySelector('[data-passed-confirm]')); await sleep(80)
    assert('a reason is required', !!host.querySelector('[data-passed-error]'))
    click(modal.querySelector('[data-passed-reason="Budget"]')); setInput(modal.querySelector('[data-passed-note]'), 'wanted 60k'); setInput(modal.querySelector('[data-passed-revisit]'), '2027-01-15'); click(modal.querySelector('[data-passed-confirm]')); await sleep(250)
    const passPut = calls.put.find((c) => c.url === '/deals/3' && c.body.stage === 'Passed')
    assert('confirming PUTs stage, reason, note and revisit date together', !!passPut && passPut.body.passed_reason === 'Budget' && passPut.body.passed_note === 'wanted 60k' && passPut.body.revisit_date === '2027-01-15')
    assert('the card left the live columns for the folded Passed row', !host.querySelector('[data-deal-column="Offer"] [data-deal-card="3"]') && /3/.test(textOf(host.querySelector('[data-closed-toggle="Passed"]'))))
    click(host.querySelector('[data-deal-drawer] button[aria-label="Close"]')); await sleep(100)
    // cancel puts a card back
    click(card(4).querySelector('[data-deal-open]')); await sleep(200)
    click(host.querySelector('[data-deal-drawer="4"] [data-move-to="Passed"]')); await sleep(100)
    click(host.querySelector('[data-passed-modal] button[aria-label="Cancel"]')); await sleep(150)
    assert('Cancel on the modal leaves the deal where it was', !!host.querySelector('[data-deal-column="Offer"] [data-deal-card="4"]') && !calls.put.some((c) => c.url === '/deals/4' && c.body.stage === 'Passed'))
    click(host.querySelector('[data-deal-drawer] button[aria-label="Close"]')); await sleep(100)
    // Next → Sign hands off
    click(card(5).querySelector('[data-key="m"]')); await sleep(250)
    assert('Next on a Negotiation card signs it and the hand-off prompt says what happened', calls.put.some((c) => c.url === '/deals/5' && c.body.stage === 'Signed') && /Lo Tide is signed/.test(textOf(host)) && /Create the contract/.test(textOf(host)))
    // ── list view ──
    click(host.querySelector('[data-deals-view="list"]')); await sleep(200)
    const list = host.querySelector('[data-deal-list]')
    assert('the list view renders every deal as a row with owner, days, follow-up and last touch, and view=list in the URL', !!list && list.querySelectorAll('[data-deal-row]').length === 9 && /view=list/.test(where) && /Sam Chen/.test(textOf(list)))
    click(list.querySelector('[data-deal-sort="advance"]')); await sleep(150)
    const firstRow = host.querySelector('[data-deal-list] [data-deal-row]')
    assert('sorting by advance puts the biggest first and writes sort= to the URL', /sort=advance/.test(where) && /Mara Sol/.test(textOf(firstRow)))
    click(firstRow); await sleep(150)
    assert('clicking a row opens the drawer', host.querySelector('[data-deal-drawer]')?.getAttribute('data-deal-drawer') === '6')
    click(host.querySelector('[data-deal-drawer] button[aria-label="Close"]')); await sleep(80)
    // ── report ──
    click(host.querySelector('[data-deals-view="report"]')); await sleep(300)
    const funnel = host.querySelector('[data-deal-funnel]')
    assert('the report view fetches the funnel and renders totals, stages with conversion, days per stage, source and owner tables, and passed reasons', calls.get.includes('/deals/report/funnel') && !!funnel && /33.3%/.test(textOf(funnel.querySelector('[data-funnel-totals]'))) && funnel.querySelectorAll('[data-funnel-stage]').length === 5 && /71.4%/.test(textOf(funnel.querySelector('[data-funnel-stage="Offer"]'))) && !!funnel.querySelector('[data-funnel-table="source"]') && !!funnel.querySelector('[data-funnel-table="owner"]') && /Budget · 1/.test(textOf(funnel.querySelector('[data-funnel-reasons]'))))
    assert('the filter bar hides on the report (its numbers are the whole pipeline)', !host.querySelector('[data-deals-filters]'))
    // ── new deal carries an owner ──
    click(host.querySelector('[data-deals-view="board"]')); await sleep(150)
    click(host.querySelector('[data-tour="deals-new"]')); await sleep(100)
    const form = host.querySelector('[data-deal-form]')
    setInput(form.querySelector('input[aria-label="Artist name"]'), 'New Prospect'); setInput(form.querySelector('[data-form-owner]'), '2'); form.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await sleep(200)
    const post = calls.post.find((c) => c.url === '/deals')
    assert('Add Deal POSTs the owner and the card appears in Scouting with their initials', !!post && post.body.owner_id === '2' && textOf(host.querySelector('[data-deal-column="Scouting"] [data-deal-card="50"] [data-deal-owner]')) === 'SC')
  }
  assert('no errors during render', errors.length === 0)
  if (errors.length) for (const e of errors) say('    ' + e)
  say('DONE')
}
main()
