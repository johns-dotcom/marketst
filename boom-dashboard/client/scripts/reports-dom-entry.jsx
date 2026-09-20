// Does the Reports page draw the second pass — basis, compare, granularity,
// charts, the new tabs, the pack, the honest balance sheet?
//
// smoke renders this page in its loading state; every one of these lives
// behind a fetch. Scenarios: full · empty · bs · vendors · budget.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import Reports from '../src/pages/Reports'
import { calls } from './reports-api-stub.js'
import { ThemeProvider } from '../src/context/ThemeContext'
import { ToastProvider } from '../src/context/ToastContext'

const errors = []
window.addEventListener('error', (e) => errors.push('window.error: ' + e.message))
// jsdom cannot follow the download anchor's blob: URL; that is the browser's job, not the page's.
console.error = (...a) => { const m = a.map(String).join(' '); if (/Warning:|Not implemented: navigation/.test(m)) return; errors.push('console.error: ' + m.slice(0, 300)) }
window.alert = (m) => errors.push('alert: ' + m)
window.URL.createObjectURL = window.URL.createObjectURL || (() => 'blob:x')
window.URL.revokeObjectURL = window.URL.revokeObjectURL || (() => {})

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
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
const setSelect = (el, v) => { Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new window.Event('change', { bubbles: true })) }

const scenario = (typeof process !== 'undefined' && process.env.REPORTS_SCENARIO) || 'full'
globalThis.__REPORTS_SCENARIO__ = scenario
try { localStorage.clear() } catch { /* no storage */ }
const START = scenario === 'bs' ? '/reports?tab=bs' : scenario === 'vendors' ? '/reports?tab=vendors' : scenario === 'budget' ? '/reports?tab=budget' : '/reports'

async function main() {
  say(`SCENARIO ${scenario}`)
  const host = document.createElement('div')
  document.body.appendChild(host)
  createRoot(host).render(<Catch><ThemeProvider><ToastProvider><MemoryRouter initialEntries={[START]}><Reports /></MemoryRouter></ToastProvider></ThemeProvider></Catch>)
  for (let i = 0; i < 60 && !host.querySelector('[data-basis-switch]'); i += 1) await sleep(100)
  await sleep(600)
  if (errors.length) for (const e of errors) say('    EARLY ' + e)
  const pnlCalls = () => calls.get.filter((c) => c.url === '/reports/pnl')

  if (scenario === 'full') {
    assert('the server-chosen default basis (ledger) is selected and marked default', host.querySelector('[data-basis="ledger"]')?.getAttribute('aria-checked') === 'true' && /default/.test(textOf(host.querySelector('[data-basis-default]'))))
    assert('the basis note reads for the ledger basis, not the bank one', /Every approved invoice marked Paid/.test(textOf(host.querySelector('[data-basis-note]'))))
    assert('the P&L was fetched ONCE, with basis=ledger — never first as bank', pnlCalls().length === 1 && pnlCalls()[0].params.basis === 'ledger')
    assert('the tabs include Vendors, Reps and Budget vs actual', /Vendors/.test(textOf(host)) && /Reps/.test(textOf(host)) && /Budget vs actual/.test(textOf(host)))
    const charts = host.querySelector('[data-report-charts]')
    assert('charts render above the table: net, mix, artists, intake, vendors', !!charts && ['net', 'mix', 'artists', 'intake', 'vendors'].every((k) => charts.querySelector(`[data-chart="${k}"]`)))
    assert('the invoices-received chart came from /reports/intake', calls.get.some((c) => c.url === '/reports/intake'))
    // granularity → quarters
    const gran = host.querySelector('[data-gran]')
    setSelect(gran, 'quarter'); await sleep(300)
    assert('quarter columns replace the six months with Q1 and Q2', /Q1 2026/.test(textOf(host)) && /Q2 2026/.test(textOf(host)) && !/Jan 26/.test(textOf(host)))
    assert('…without refetching (a client-side rollup)', pnlCalls().length === 1)
    setSelect(gran, 'month'); await sleep(200)
    // compare → prior period
    setSelect(host.querySelector('[data-compare]'), 'prior'); await sleep(500)
    // The page opens on Jan 1 → today, so the prior range ends 2025-12-31 and starts as many months earlier.
    const second = pnlCalls().find((c) => c.params.to === '2025-12-31')
    assert('comparing with the prior period fetches the same report for the range immediately before, same basis', !!second && second.params.from < '2026-01-01' && second.params.basis === 'ledger')
    const cmp = host.querySelector('[data-compare-panel]')
    assert('the comparison panel shows income / expenses / net with the compared figure and the change', !!cmp && cmp.querySelectorAll('[data-compare-total]').length === 3 && /was \$/.test(textOf(cmp)) && /\+\$|−\$/.test(textOf(cmp)))
    assert('…and lines, biggest mover first', cmp.querySelectorAll('[data-compare-line]').length >= 3 && cmp.querySelector('[data-compare-line]')?.getAttribute('data-compare-line') === 'Royalties')
    // switching basis refetches
    click(host.querySelector('[data-basis="accrual"]')); await sleep(400)
    assert('picking a basis refetches with it and the note follows', pnlCalls().some((c) => c.params.basis === 'accrual') && /paid or not/.test(textOf(host.querySelector('[data-basis-note]'))))
    // pack
    click(host.querySelector('[data-pack-open]')); await sleep(300)
    const modal = host.querySelector('[data-pack-modal]')
    assert('the Accountant pack modal opens and loaded the settings', !!modal && calls.get.some((c) => c.url === '/reports/pack/settings') && !!modal.querySelector('[data-pack-recipients]'))
    click(modal.querySelector('[data-pack-download]')); await sleep(200)
    assert('Download asks for the pack for the range on screen, on the current basis', calls.get.some((c) => /\/reports\/pack\.xlsx\?from=2026-01-01&to=/.test(c.url) && /basis=accrual/.test(c.url)))
    assert('Send now is disabled until there are recipients', modal.querySelector('[data-pack-send]')?.disabled === true)
  }
  if (scenario === 'empty') {
    assert('with nothing to draw the charts say so instead of drawing nothing', !!host.querySelector('[data-charts-empty]') && !host.querySelector('[data-report-charts]'))
  }
  if (scenario === 'bs') {
    const proof = host.querySelector('[data-bs-proof]')
    assert('the balance sheet says cash is UNKNOWN with no statement, and lists where each line comes from', !!proof && proof.getAttribute('data-bs-cash-known') === '0' && /UNKNOWN/.test(textOf(proof)) && /Accounts payable/.test(textOf(proof)))
    assert('the derived line is labelled as such, not as equity', /Unexplained difference \(derived\)/.test(textOf(host)) && !/Accumulated deficit/.test(textOf(host)))
  }
  if (scenario === 'vendors') {
    const t = host.querySelector('[data-spendby="vendor"]')
    assert('the Vendors tab lists vendors with months across and a total column', !!t && t.querySelectorAll('[data-spendby-row]').length === 2 && /Northgate Studios/.test(textOf(t)) && /\$1,800/.test(textOf(t)))
    assert('…fetched with the basis', calls.get.some((c) => c.url === '/reports/spend-by' && c.params.dim === 'vendor' && c.params.basis === 'ledger'))
    setSelect(host.querySelector('[data-gran]'), 'quarter'); await sleep(200)
    assert('quarter columns roll the vendor months up too', /Q1 2026/.test(textOf(host.querySelector('[data-spendby="vendor"]'))))
  }
  if (scenario === 'budget') {
    const b = host.querySelector('[data-budget-vs-actual]')
    assert('Budget vs actual lists budgeted artists, flags the one over on marketing, links to the sheet', !!b && b.querySelectorAll('[data-bva-row]').length === 2 && !!b.querySelector('[data-bva-over="1"]') && /−\$600|-\$600/.test(textOf(b)) && !!b.querySelector('a[href^="/artist-budgets/rosavale"]'))
  }
  assert('no errors during render', errors.length === 0)
  if (errors.length) for (const e of errors) say('    ' + e)
  say('DONE')
}
main()
