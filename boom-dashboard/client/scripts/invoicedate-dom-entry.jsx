// Can you actually edit the date an invoice bears?
//
// `npm run smoke` renders this page at 255 bytes — its loading branch — so every
// field, including the one under test, is in the half smoke never reaches. This
// page has ALSO gone pure white once already, from a `const` read above its own
// declaration, with `vite build` green. So it gets mounted for real.
//
// What is at risk:
//
//   THE ANCHOR THE PREVIEW USES   the page computes no date itself; it asks
//                                 GET /invoices/due-date. If the typed date is
//                                 not in those params, the deadline on screen is
//                                 counted from a different day than the one the
//                                 document will print — which is the entire
//                                 failure lib/payment-terms.js exists to stop.
//
//   AN EDIT LOADS ITS OWN DATE    opening a saved invoice must show the date it
//                                 bears, not today. The fixture's invoice is
//                                 dated February so the two can never coincide.
//
//   THE SAVE CARRIES IT           a field that renders and is not sent is worse
//                                 than no field.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import CreateInvoice from '../src/pages/CreateInvoice'
import { calls, EXISTING } from './invoicedate-api-stub.js'
import { ThemeProvider } from '../src/context/ThemeContext'
import { ToastProvider } from '../src/context/ToastContext'

const errors = []
window.addEventListener('error', (e) => errors.push('window.error: ' + e.message))
console.error = (...a) => { errors.push('console.error: ' + a.map(String).join(' ').slice(0, 300)) }

class Catch extends React.Component {
  constructor(p) { super(p); this.state = { err: null } }
  static getDerivedStateFromError(err) { return { err } }
  componentDidCatch(err) {
    errors.push('THROWN: ' + (err && err.message))
    errors.push('STACK: ' + String((err && err.stack) || '').split('\n').slice(0, 5).join(' | '))
  }
  render() { return this.state.err ? null : this.props.children }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const say = (...a) => console.log(...a)
let host
const assert = (label, cond) => say(`  ${label} -> ${!!cond}`)
const textOf = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '')
const all = (sel) => [...host.querySelectorAll(sel)]
const click = (el) => el && el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
const setValue = (el, v) => {
  const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
  el.dispatchEvent(new window.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
}
const dateInput = () => all('input[type=date]').find((i) => /invoice date/i.test(i.getAttribute('aria-label') || ''))
const lastDueAsk = () => [...calls.get].reverse().find((c) => c.url.startsWith('/invoices/due-date'))

async function main() {
  host = document.createElement('div')
  document.body.appendChild(host)
  createRoot(host).render(
    <Catch>
      <ThemeProvider><ToastProvider>
        <MemoryRouter initialEntries={['/create-invoice']}>
          <CreateInvoice />
        </MemoryRouter>
      </ToastProvider></ThemeProvider>
    </Catch>
  )
  await sleep(700)

  say('\nRENDER')
  assert('the page rendered, not its loading branch', host.innerHTML.length > 3000)
  assert('no error was thrown', errors.length === 0)
  if (errors.length) for (const e of errors.slice(0, 4)) say('     ' + e)

  say('\nTHE FIELD EXISTS')
  assert('there is an invoice-date input', !!dateInput())
  assert('it is labelled', /Invoice Date/i.test(textOf(host)))
  assert('a new invoice leaves it blank', dateInput() && dateInput().value === '')
  assert('and says what blank means', /unless you pick another day/i.test(textOf(host)))

  say('\nTHE PREVIEW ANCHORS ON WHAT IS TYPED')
  const before = lastDueAsk()
  assert('the page asked the server for the date at all', !!before)
  assert('and sent no anchor for a fresh invoice', !before?.params?.date)
  setValue(dateInput(), '2026-06-10')
  await sleep(400)
  const after = lastDueAsk()
  assert('typing a date re-asks the server', after !== before)
  assert('sending it as the anchor', after?.params?.date === '2026-06-10')
  assert('the deadline on screen counts from THAT day', /2026-07-10/.test(textOf(host)))
  // The whole point: a deadline counted from a day the document will not print
  // is the bug this page was rebuilt around.
  assert('and not from today', !/2026-10-15/.test(textOf(host)))

  say('\nCLEARING IT GOES BACK TO TODAY')
  const reset = all('button').find((b) => /use today's date/i.test(textOf(b)))
  assert('there is a way back to the default', !!reset)
  click(reset)
  await sleep(400)
  assert('the field is empty again', dateInput() && dateInput().value === '')
  assert('and the anchor is dropped from the request', !lastDueAsk()?.params?.date)

  say('\nEDITING A SAVED INVOICE LOADS ITS OWN DATE')
  const edit = all('button').find((b) => /^edit$/i.test(textOf(b)))
    || all('button').find((b) => /edit/i.test(b.getAttribute('title') || ''))
  assert('the saved invoice offers an edit', !!edit)
  if (edit) {
    click(edit)
    await sleep(500)
    assert(`the field holds the invoice's own date (${EXISTING.invoice_date})`,
      dateInput() && dateInput().value === EXISTING.invoice_date)
    assert('which is NOT today', dateInput() && dateInput().value !== '2026-09-15')

    say('\nAND THE SAVE CARRIES IT')
    setValue(dateInput(), '2026-02-20')
    await sleep(400)
    const form = host.querySelector('form')
    if (form) form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    await sleep(500)
    const put = calls.put.find((c) => /\/invoices\/7$/.test(c.url))
    assert('the edit was PUT', !!put)
    assert('with the date on it', put?.body?.invoice_date === '2026-02-20')
    assert('and the terms beside it, so the server can re-count',
      !!put?.body?.payment_terms)
  }

  say('\nno late errors -> ' + (errors.length === 0))
  if (errors.length) for (const e of errors.slice(0, 6)) say('     ' + e)
  say('\nDONE')
}

const finish = () => { globalThis.__DONE__ = true }
main()
  .catch((e) => { console.log('HARNESS THREW: ' + e.message); console.log('DONE') })
  .finally(finish)
