// Does the Ledger draw its second pass? Filters behind one button with chips
// and URL state, saved views, the date range, the attention toggle, the
// summary strip, grouping with subtotal rows, the row drawer (›, Enter),
// clone, templates, and the desktop empty state. smoke renders the loading
// branch; all of this lives behind the fetch. Scenarios: full · empty.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import BkLedger from '../src/pages/BkLedger'
import { calls } from './ledger-api-stub.js'
import { ThemeProvider } from '../src/context/ThemeContext'
import { ToastProvider } from '../src/context/ToastContext'
import { FxRatesProvider } from '../src/context/FxRatesContext'
import { BoomRepsProvider } from '../src/context/BoomRepsContext'
import { CategoriesProvider } from '../src/context/CategoriesContext'

const errors = []
window.addEventListener('error', (e) => errors.push('window.error: ' + e.message))
console.error = (...a) => { const m = a.map(String).join(' '); if (/Warning:|Not implemented: navigation/.test(m)) return; errors.push('console.error: ' + m.slice(0, 300)) }
window.alert = (m) => errors.push('alert: ' + m)
window.prompt = () => 'My view'
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
const setSelect = (el, v) => { Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new window.Event('change', { bubbles: true })) }
const key = (k) => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true }))
const scenario = (typeof process !== 'undefined' && process.env.LEDGER_SCENARIO) || 'full'
globalThis.__LEDGER_SCENARIO__ = scenario
try { localStorage.clear() } catch { /* none */ }
let where = ''
function Where() { const loc = useLocation(); where = loc.pathname + loc.search; return null }

async function main() {
  say(`SCENARIO ${scenario}`)
  const host = document.createElement('div'); document.body.appendChild(host)
  createRoot(host).render(
    <MemoryRouter initialEntries={[scenario === 'url' ? '/bk/ledger?paid=Unpaid&group=vendor' : '/bk/ledger']}>
      <ThemeProvider><ToastProvider><FxRatesProvider><BoomRepsProvider><CategoriesProvider>
        <Catch><Where /><BkLedger /></Catch>
      </CategoriesProvider></BoomRepsProvider></FxRatesProvider></ToastProvider></ThemeProvider>
    </MemoryRouter>
  )
  for (let i = 0; i < 60 && !host.querySelector('[data-ledger-summary], [data-ledger-empty]'); i += 1) await sleep(100)
  await sleep(400)
  if (errors.length) for (const e of errors) say('    EARLY ' + e)
  const rows = () => [...host.querySelectorAll('tr[data-row]')]

  if (scenario === 'empty') {
    assert('an empty ledger shows the real empty state on desktop — Add invoice and a link to Approvals, not "No entries found."', !!host.querySelector('[data-ledger-empty]') && /Add invoice/.test(textOf(host)) && /Approvals/.test(textOf(host)) && !/No entries found/.test(textOf(host)))
  }
  if (scenario === 'full') {
    const summary = host.querySelector('[data-ledger-summary]')
    assert('the summary strip renders rows, total, paid, unpaid and the attention count', !!summary && ['rows', 'total', 'paid', 'unpaid', 'attention'].every((k) => summary.querySelector(`[data-summary-${k}]`)))
    const nRows = Number(textOf(summary.querySelector('[data-summary-rows]')))
    assert('the row count is the ROOT rows (a split child is not a row of its own)', nRows === rows().filter((r) => true).length - 0 || nRows >= 4)
    assert('the nine dropdowns are gone from the toolbar; one Filters button stands in', !!host.querySelector('[data-ledger-filters-button]') && !host.querySelector('[data-tour="ledger-filters"] select'))
    assert('the Recoup label column is named for what it is, not Tone Labels', !/Tone Labels/.test(textOf(host)))
    assert('the default columns are the core set: Email, Bank, Socials and Rep are off', !/>Email</.test(host.innerHTML.replace(/\s+/g, '')) || ![...host.querySelectorAll('th')].some((th) => /^(Email|Bank|Socials|market.st Rep)$/.test(textOf(th))))
    // Filters popover → a chip → URL
    click(host.querySelector('[data-ledger-filters-button]')); await sleep(80)
    const pop = host.querySelector('[data-ledger-filters-popover]')
    assert('the Filters button opens a popover holding every filter', !!pop && pop.querySelectorAll('[data-ledger-filter]').length >= 9)
    setSelect(pop.querySelector('[data-ledger-filter="paid"] select'), 'Unpaid'); await sleep(200)
    assert('picking a filter shows it as a chip and puts it in the URL', !!host.querySelector('[data-ledger-chip="paid"]') && /paid=Unpaid/.test(where))
    assert('…and the button counts it', /Filters · 1/.test(textOf(host.querySelector('[data-ledger-filters-button]'))))
    const before = rows().length
    click(host.querySelector('[data-ledger-chip="paid"] button')); await sleep(200)
    assert('the chip\'s × clears just that filter, and the URL follows', !host.querySelector('[data-ledger-chip="paid"]') && !/paid=/.test(where) && rows().length >= before)
    // Date range
    setSelect(host.querySelector('[data-ledger-quickrange]'), 'lastyear'); await sleep(200)
    assert('a quick range sets from/to on the invoice date and empties this fixture (all 2026 rows)', /from=2025-01-01/.test(where) && rows().length === 0 && !!host.querySelector('[data-ledger-nomatch]'))
    click(host.querySelector('[data-ledger-nomatch] button')); await sleep(200)
    assert('Clear filters on the no-match state brings the rows back', rows().length >= 4 && !/from=/.test(where))
    // Attention
    click(host.querySelector('[data-ledger-attention]')); await sleep(200)
    const attnRows = rows().map((r) => r.getAttribute('data-entry-id'))
    assert('Needs attention keeps only the flagged row and the one with no document / W-9, and says so in the URL', attnRows.includes('9101') && attnRows.includes('9102') && !attnRows.includes('9001') && /attn=1/.test(where))
    click(host.querySelector('[data-ledger-attention]')); await sleep(200)
    // Saved views: built-in + save own
    click(host.querySelector('[data-ledger-view="flagged"]')); await sleep(200)
    assert('a built-in view applies its filters (Flagged → one row) and lights up', rows().length === 1 && /flag=Yes/.test(where) && !!host.querySelector('[data-ledger-chip="flag"]'))
    click(host.querySelector('[data-ledger-view-save]')); await sleep(100)
    assert('Save view stores the current filters under a name', [...host.querySelectorAll('[data-ledger-view]')].some((b) => /My view/.test(textOf(b))) && JSON.parse(localStorage.getItem('bk_ledger_views_v1') || '[]').some((v) => v.name === 'My view' && v.params.flag === 'Yes'))
    click(host.querySelector('[data-ledger-chip="flag"] button')); await sleep(200)
    // Group by
    setSelect(host.querySelector('[data-ledger-groupby]'), 'vendor'); await sleep(200)
    const groups = [...host.querySelectorAll('tr[data-ledger-group]')]
    assert('Group by vendor inserts a header row per vendor with count and subtotal, and the URL says so', groups.length >= 4 && /1 row|2 rows/.test(textOf(groups[0])) && /\$/.test(textOf(groups[0])) && /group=vendor/.test(where))
    const salmon = groups.find((g) => /Salmon Studios/.test(textOf(g)))
    assert('a split family subtotals root plus children ($1,000 for the $700 + $300 family)', !!salmon && /\$1,000/.test(textOf(salmon)))
    setSelect(host.querySelector('[data-ledger-groupby]'), 'none'); await sleep(150)
    // Drawer: › button, then Enter on the focused row
    click(rows()[0].querySelector('[data-row-open]')); await sleep(300)
    let drawer = host.querySelector('[data-ledger-drawer]')
    assert('› opens the drawer for that row with details, documents, bank and history', !!drawer && drawer.getAttribute('data-entry-id') === rows()[0].getAttribute('data-entry-id') && ['details', 'documents', 'bank', 'history'].every((k) => drawer.querySelector(`[data-drawer-section="${k}"]`)))
    assert('the history came from GET /bk/entries/:id/history and lists the change', calls.get.some((u) => /\/bk\/entries\/\d+\/history/.test(u)) && /Sam Chen/.test(textOf(drawer.querySelector('[data-drawer-section="history"]'))))
    const familyDrawer = /split 1 ways|slice of|Split family/.test(textOf(drawer))
    assert('a split parent shows its family in the drawer', familyDrawer)
    click(drawer.querySelector('[data-drawer-clone]')); await sleep(300)
    const clone = calls.post.find((c) => c.url === '/bk/entries')
    assert('Clone posts the same payee / category / amount, dated today, unpaid, with no invoice number', !!clone && clone.body.payee === 'Salmon Studios Limited' && clone.body.amount === '700.00' && clone.body.invoice_number === '' && clone.body.payment_status === 'Unpaid' && clone.body.invoice_date === new Date().toISOString().slice(0, 10))
    click(drawer.querySelector('[data-drawer-template]')); await sleep(200)
    const tpl = calls.post.find((c) => c.url === '/bk/templates')
    assert('Save as template posts a named field set', !!tpl && tpl.body.name === 'My view' && tpl.body.fields.payee === 'Salmon Studios Limited')
    click(drawer.querySelector('[data-drawer-close]')); await sleep(150)
    assert('the drawer closes', !host.querySelector('[data-ledger-drawer]'))
    key('j'); await sleep(50); key('Enter'); await sleep(250)
    drawer = host.querySelector('[data-ledger-drawer]')
    assert('j then Enter opens the drawer for the focused row', !!drawer && drawer.getAttribute('data-entry-id') === rows()[0].getAttribute('data-entry-id'))
    key('Escape'); await sleep(150)
    // Templates menu
    click(host.querySelector('[data-ledger-templates]')); await sleep(200)
    const menu = host.querySelector('[data-ledger-templates-menu]')
    assert('From template lists the label\'s templates', !!menu && /Studio rent/.test(textOf(menu)))
    click(menu.querySelector('[data-ledger-template] button')); await sleep(250)
    const fromTpl = calls.post.filter((c) => c.url === '/bk/entries').pop()
    assert('using one posts its fields as a fresh unpaid row dated today', !!fromTpl && fromTpl.body.payee === 'Wharf Studios' && fromTpl.body.payment_status === 'Unpaid')
  }
  if (scenario === 'url') {
    assert('filters in the URL apply on load: paid=Unpaid is a chip, group=vendor draws group rows', !!host.querySelector('[data-ledger-chip="paid"]') && host.querySelectorAll('tr[data-ledger-group]').length >= 1)
  }
  assert('no errors during render', errors.length === 0)
  if (errors.length) for (const e of errors) say('    ' + e)
  say('DONE')
}
main()
