// Mount the Payment Dashboard and pay several invoices as ONE payment.
//
// John: "I want to be able to select multiple invoices as paid out in one sum."
// The batch flow already marked N invoices Paid; what it never recorded is that
// they were a SINGLE payment. Measured on production 2026-08-28: 112 batches
// covering 300 paid invoices worth $473,714.58 look like one wire each, and
// ZERO carry a settlement group — so when the statement lands with one debit,
// the matcher (1:1 on an amount equal to the cent) pairs it with nothing.
//
// `npm run smoke` renders this page in its LOADING state and never opens the
// batch modal, so none of the new code runs there. This asserts the four things
// that actually matter:
//
//   • the modal leads with the SUM and defaults the declaration on
//   • confirming posts the group on FAMILY ROOTS, not the selected rows
//   • a two-vendor selection cannot declare it, and posts no group
//   • a FAILED mark-paid posts no group — a half-applied batch must never be
//     recorded as one payment
import React from 'react'
import { createRoot } from 'react-dom/client'
import BkPayments from '../src/pages/BkPayments'
import { calls, failPuts } from './payments-api-stub.js'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '../src/context/ThemeContext'
import { ToastProvider } from '../src/context/ToastContext'
import { FxRatesProvider } from '../src/context/FxRatesContext'
import { BoomRepsProvider } from '../src/context/BoomRepsContext'
import { CategoriesProvider } from '../src/context/CategoriesContext'

const errors = []
window.addEventListener('error', (e) => errors.push('window.error: ' + e.message))
const origError = console.error
console.error = (...a) => { errors.push('console.error: ' + a.map(String).join(' ').slice(0, 300)) }

class Catch extends React.Component {
  constructor(p) { super(p); this.state = { err: null } }
  static getDerivedStateFromError(err) { return { err } }
  componentDidCatch(err) {
    errors.push('THROWN: ' + (err && err.message))
    errors.push('STACK: ' + String((err && err.stack) || '').split('\n').slice(0, 6).join(' | '))
  }
  render() { return this.state.err ? null : this.props.children }
}

createRoot(document.getElementById('root')).render(
  <MemoryRouter initialEntries={['/bk/payments']}>
    <ThemeProvider><ToastProvider><FxRatesProvider><BoomRepsProvider><CategoriesProvider>
      <Catch><BkPayments /></Catch>
    </CategoriesProvider></BoomRepsProvider></FxRatesProvider></ToastProvider></ThemeProvider>
  </MemoryRouter>
)

const click = (el) => el && el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
const text = () => document.getElementById('root').textContent || ''
const btn = (re) => [...document.querySelectorAll('button')].find((b) => re.test((b.textContent || '').trim()))
const boxes = () => [...document.querySelectorAll('input[type=checkbox]')]
const postsTo = (u) => calls.post.filter((c) => c.url === u)

// Row checkboxes carry no id, so they are located by walking to the row that
// contains the invoice number — the way a person picks them.
const rowBoxFor = (invNo) => {
  const cell = [...document.querySelectorAll('td')].find((t) => (t.textContent || '').trim() === invNo)
  return cell?.closest('tr')?.querySelector('input[type=checkbox]') || null
}
const selectRows = (nos) => { for (const n of nos) click(rowBoxFor(n)) }

const run = async () => {
  console.log('rendered bytes:', document.getElementById('root').innerHTML.length)
  console.log('rows loaded ->', /INV-101/.test(text()), '| checkboxes:', boxes().length)

  // ── 1. one vendor, two invoices (one of them a split parent) ─────────────
  selectRows(['INV-101', 'INV-102'])
  await new Promise(r => setTimeout(r, 150))
  console.log('\n1. ONE VENDOR')
  console.log('   toolbar Selected Total ->', (text().match(/Selected Total(\$[\d,]+\.\d\d)/) || [])[1])
  click(btn(/^Mark Selected Paid/))
  await new Promise(r => setTimeout(r, 250))
  console.log('   modal open ->', /Pay these together/.test(text()))
  // $2,400 = 101's FAMILY (800 + its 400 child) + 102's 1,200. A headline that
  // said $2,000 would be quoting the parent's slice, not the invoice.
  console.log('   headline sum ->', (text().match(/Pay these together\s*(\$[\d,]+\.\d\d)/) || [])[1],
    '(expect $2,400.00 — family-aware)')
  console.log('   names the vendor ->', /to Slippy Clouds Ltd/.test(text()))
  const decl = boxes().find((b) => b.closest('label') && /ONE payment/.test(b.closest('label').textContent))
  console.log('   declaration present ->', !!decl, '| checked by default ->', !!decl?.checked, '| enabled ->', !decl?.disabled)
  click(btn(/^Mark \d+ Paid$/))   // the MODAL's confirm; the toolbar reads "Mark Selected Paid"
  await new Promise(r => setTimeout(r, 400))
  const puts = calls.put.filter((c) => /\/bk\/payments\/\d+$/.test(c.url))
  console.log('   PUTs fired ->', puts.length, puts.map((p) => p.url.split('/').pop()).join(','))
  const g = postsTo('/bk/settlement-groups')
  console.log('   group posted ->', g.length === 1, JSON.stringify(g[0]?.body || null))
  console.log('   ...on FAMILY ROOTS (101,102 — not the child 103) ->',
    JSON.stringify((g[0]?.body?.expense_ids || []).slice().sort()) === '[101,102]')

  // ── 2. two vendors ───────────────────────────────────────────────────────
  calls.post.length = 0; calls.put.length = 0
  await new Promise(r => setTimeout(r, 200))
  selectRows(['INV-201', 'INV-301'])
  await new Promise(r => setTimeout(r, 150))
  console.log('\n2. TWO VENDORS')
  click(btn(/^Mark Selected Paid/))
  await new Promise(r => setTimeout(r, 250))
  const d2 = boxes().find((b) => b.closest('label') && /ONE payment/.test(b.closest('label').textContent))
  console.log('   declaration disabled ->', !!d2?.disabled, '| unchecked ->', d2 ? !d2.checked : null)
  console.log('   says why ->', /spans 2/.test(text()))
  console.log('   both vendors named ->', /Majed LLC/.test(text()) && /Spade Group/.test(text()))
  console.log('   shows the per-vendor split ->', /\$2,000\.00/.test(text()) && /\$500\.00/.test(text()))
  click(btn(/^Mark \d+ Paid$/))   // the MODAL's confirm; the toolbar reads "Mark Selected Paid"
  await new Promise(r => setTimeout(r, 400))
  console.log('   marked paid ->', calls.put.filter((c) => /\/bk\/payments\/\d+$/.test(c.url)).length)
  console.log('   NO group posted ->', postsTo('/bk/settlement-groups').length === 0)

  // ── 3. a failed mark-paid must not declare anything ──────────────────────
  calls.post.length = 0; calls.put.length = 0
  failPuts.on = true
  await new Promise(r => setTimeout(r, 200))
  selectRows(['INV-302', 'INV-303'])
  await new Promise(r => setTimeout(r, 150))
  click(btn(/^Mark Selected Paid/))
  await new Promise(r => setTimeout(r, 250))
  click(btn(/^Mark \d+ Paid$/))   // the MODAL's confirm; the toolbar reads "Mark Selected Paid"
  await new Promise(r => setTimeout(r, 400))
  console.log('\n3. A MARK-PAID THAT FAILS')
  console.log('   NO group posted ->', postsTo('/bk/settlement-groups').length === 0,
    '(a half-applied batch recorded as one payment would tell the matcher to settle a line with unpaid invoices)')
  failPuts.on = false
}

setTimeout(() => { run().catch((e) => console.log('RUN THREW:', e.message)) }, 900)

setTimeout(() => {
  console.error = origError
  if (errors.length) {
    console.log('\n--- errors ---')
    for (const e of [...new Set(errors)].slice(0, 8)) console.log(e)
  } else console.log('\nno errors captured')
  globalThis.__DONE__ = true
}, 4200)
