// Does the ledger actually SHOW what the vendor submitted?
//
// `npm run smoke` renders BkLedger in its loading state — 1,050 bytes, no rows,
// no cells — so it cannot see a column that only exists once there is a row to
// draw it on. These thirteen columns are all in that branch, and two of them
// (the split child inheriting its family's answers, and the payment-check
// verdict) are logic rather than a field read.
//
// Four things, against the fixture in scripts/ledgervendor-api-stub.js:
//
//   1. the columns are OFF by default — the ask was that the data be reachable,
//      not that the table get thirteen columns wider for everybody
//   2. one click on the preset turns the whole block on
//   3. the values render, including a split CHILD showing its parent's answers
//      rather than blanks, and the mismatch verdict reading as a mismatch
//   4. "Bulk" stops appearing twice: the Source chip yields to the Bulk? column
//      when that column is on, and comes back when it is off
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import BkLedger from '../src/pages/BkLedger'
import { calls } from './ledgervendor-api-stub.js'
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
    errors.push('STACK: ' + String((err && err.stack) || '').split('\n').slice(0, 5).join(' | '))
  }
  render() { return this.state.err ? null : this.props.children }
}

// localStorage decides which columns are hidden, and a previous run's choice
// would make "off by default" pass or fail for the wrong reason.
window.localStorage.clear()

createRoot(document.getElementById('root')).render(
  <MemoryRouter initialEntries={['/bk/ledger']}>
    <ThemeProvider><ToastProvider><FxRatesProvider><BoomRepsProvider><CategoriesProvider>
      <Catch><BkLedger /></Catch>
    </CategoriesProvider></BoomRepsProvider></FxRatesProvider></ToastProvider></ThemeProvider>
  </MemoryRouter>
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
const all = (sel) => [...document.querySelectorAll(sel)]
const headers = () => all('th').map((th) => (th.textContent || '').trim())
const bodyText = () => document.body.textContent || ''
// Most ledger cells are editable, so their value lives in an <input> and never
// appears in textContent. A row's readable content is both.
const rowText = (tr) => (tr
  ? (tr.textContent || '') + ' ' + all('tr').indexOf(tr) + ' '
    + [...tr.querySelectorAll('input')].map((i) => i.value).join(' ')
  : '')
// The row for one fixture invoice, by the invoice number only that row carries.
const rowFor = (invNo) => all('tr').find((tr) => rowText(tr).includes(invNo))
const say = (...a) => console.log(...a)
const SCENARIO = process.env.SCENARIO || 'columns'
// React tracks a controlled input's value; set it through the descriptor or the
// synthetic onChange is deduped away.
const type = (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(el, value)
  el.dispatchEvent(new window.Event('input', { bubbles: true }))
}

const NEW_HEADERS = ['Vendor Name', 'CC Emails', 'Acct Type', 'Name on Acct', 'Acct ••',
  'Wire', 'Bank Addr', 'Benef. Addr', 'Intermediary', 'PayPal', 'Details vs Inv',
  'Off Roster?', 'Files']

;(async () => {
  await sleep(1800)
  say('SETUP: rows rendered ->', all('tr').some((tr) => rowText(tr).includes('Salmon Studios Limited')))
  say('SETUP: /bk/entries was fetched ->', calls.get.some((c) => c.url.startsWith('/bk/entries?')))

  // ── The split dialog still works after moving out of this page ─────────
  //
  // It was 180 lines of JSX inside BkLedger until the Payments dashboard needed
  // the same thing; both now render components/SplitInvoiceModal. The property
  // most easily lost in that move is the one asserted hardest below: the dialog
  // divides the FAMILY total, not the parent's leftover share. This fixture's
  // family is $700 + $300, and a dialog offering to divide $700 would silently
  // delete $300 from the invoice.
  if (SCENARIO === 'split') {
    const parent = rowFor('SS-1611')
    const scissors = parent && [...parent.querySelectorAll('button')]
      .find((b) => /Split between artists/.test(b.getAttribute('title') || ''))
    say('SPLIT: the row offers a split ->', !!scissors)
    if (!scissors) { globalThis.__DONE__ = true; return }
    click(scissors)
    await sleep(400)
    say('SPLIT: the dialog opened ->', /Split between artists/.test(bodyText()))
    say('SPLIT: it divides the FAMILY total, not the parent slice ->',
      /\$1,000\.00/.test(bodyText()) && !/— \$700\.00/.test(bodyText()))
    const amounts = () => all('input[type="number"]').map((i) => i.value)
    // The amounts come back as the server sent them ('700.00'), not renumbered.
    say('SPLIT: it opens on the split that already exists ->',
      amounts().join('+') === '700.00+300.00', `(${amounts().join(', ')})`)
    const artistBoxes = all('input[type="text"]').filter((i) => /Artist/.test(i.placeholder || ''))
    say('SPLIT: and names its artists ->', artistBoxes.map((i) => i.value).join('/') === 'Jerri/Kaia',
      artistBoxes.map((i) => i.value).join('/'))
    const evenly = all('button').find((b) => /Split evenly/.test(b.textContent || ''))
    if (evenly) click(evenly)
    await sleep(250)
    say('SPLIT: even is even ->', amounts().join('+') === '500.00+500.00', `(${amounts().join(', ')})`)
    const go = all('button').find((b) => (b.textContent || '').trim() === 'Split')
    if (go) click(go)
    await sleep(900)
    const posted = calls.post.filter((c) => /\/split$/.test(c.url)).pop()
    say('SPLIT: POST …/split fired ->', !!posted, posted?.url)
    const bd = posted?.body?.artist_breakdown || []
    say('SPLIT: two slices, adding to the family total ->',
      bd.length === 2 && Math.abs(bd.reduce((s, x) => s + Number(x.amount || 0), 0) - 1000) < 0.005,
      JSON.stringify(bd))
    console.error = origError
    if (errors.length) { say('--- errors ---'); for (const e of [...new Set(errors)].slice(0, 8)) say(e) }
    else say('no errors captured')
    globalThis.__DONE__ = true
    return
  }

  // 1. off by default
  const onAtStart = NEW_HEADERS.filter((h) => headers().includes(h))
  say('DEFAULT: none of the vendor-form columns are on ->', onAtStart.length === 0,
    onAtStart.length ? `(showing: ${onAtStart.join(', ')})` : '')

  // 2. the preset
  const colsBtn = all('button').find((b) => (b.textContent || '').trim() === 'Columns')
  say('MENU: Columns button found ->', !!colsBtn)
  if (!colsBtn) { globalThis.__DONE__ = true; return }
  click(colsBtn)
  await sleep(250)
  say('MENU: the group heading names the block ->', bodyText().includes('Vendor form'))
  say('MENU: and warns the older rows are empty ->', /did not collect it yet/.test(bodyText()))
  const preset = all('button').find((b) => /Show everything the vendor submitted/.test(b.textContent || ''))
  say('MENU: preset found ->', !!preset)
  if (preset) click(preset)
  await sleep(400)
  const missing = NEW_HEADERS.filter((h) => !headers().includes(h))
  say('PRESET: every vendor-form column is now a column ->', missing.length === 0,
    missing.length ? `(missing: ${missing.join(', ')})` : '')

  // 3. the values
  const parent = rowFor('SS-1611')
  const pText = rowText(parent)
  say('VALUES: the vendor’s own spelling of their name ->', /Salmon Studios Ltd \(trading as Salmon\)/.test(pText))
  say('VALUES: CC addresses ->', /ap@salmonstudios\.net/.test(pText))
  say('VALUES: account type ->', /Checking/.test(pText))
  say('VALUES: name on account ->', /Salmon Studios Limited/.test(pText))
  say('VALUES: masked account ->', /••8613/.test(pText))
  say('VALUES: bank address ->', /1 Bank Plaza/.test(pText))
  say('VALUES: extra file count ->', />3<|3/.test(pText))
  say('VALUES: a mismatch reads as a mismatch ->', /Mismatch/.test(pText))

  const wire = rowFor('CW-88')
  const wText = rowText(wire)
  say('WIRE: scope ->', /International/.test(wText))
  say('WIRE: beneficiary address ->', /Memorandumului/.test(wText))
  say('WIRE: intermediary bank ->', /Citibank/.test(wText))
  say('WIRE: off-roster artist flagged ->', /Yes/.test(wText))

  const pp = rowText(rowFor('G-12'))
  say('PAYPAL: the handle is shown ->', /grayson@example\.com/.test(pp))
  say('PAYPAL: "not on invoice" rather than a bare verdict ->', /Not on invoice/.test(pp))

  // The child carries no submission of its own; it must show the family's.
  // Split children are collapsed behind the parent's caret, so open it first.
  const caret = parent && [...parent.querySelectorAll('button, span')]
    .find((el) => /▶|▼/.test(el.textContent || ''))
  if (caret) click(caret)
  await sleep(350)
  const child = all('tr').find((tr) => rowText(tr).includes('Kaia'))
  say('CHILD: the split child is on screen ->', !!child)
  const cText = rowText(child)
  say('CHILD: a split child shows its family’s account ->', /••8613/.test(cText))
  say('CHILD: and its family’s CC addresses ->', /ap@salmonstudios\.net/.test(cText))

  // 4. Bulk, once
  const bulkRow = () => rowFor('DS-3')
  // The duplication John reported is not the word twice in a row — it is the
  // same FACT in two places: a Bulk? column reading Yes and a BULK chip in
  // Source. So this looks at the Source cell itself, found by its badge text
  // rather than by column index (the ledger renders its frozen columns as one
  // merged cell, so header and body indices do not line up).
  const sourceCell = () => [...(bulkRow()?.querySelectorAll('td') || [])]
    .find((td) => /^(admin|vendor|bank|recoupment|campaign)(bulk)?$/i.test((td.textContent || '').trim()))
  const chipShown = () => /bulk/i.test(sourceCell()?.textContent || '')
  say('BULK: the Source cell was found ->', !!sourceCell(), `("${(sourceCell()?.textContent || '').trim()}")`)
  say('BULK: with the Bulk? column off, Source carries the chip ->', chipShown() === true)
  const bulkToggle = all('label').find((l) => /^Bulk Deal\?$/.test((l.textContent || '').trim()))
  say('BULK: the Bulk Deal? toggle is in the menu ->', !!bulkToggle)
  if (bulkToggle) click(bulkToggle.querySelector('input'))
  await sleep(300)
  say('BULK: with the column on, the Source chip is gone ->', chipShown() === false,
    `(Source reads "${(sourceCell()?.textContent || '').trim()}")`)
  say('BULK: and the column itself says Yes ->', /Yes/.test(bulkRow()?.textContent || ''))
  if (bulkToggle) click(bulkToggle.querySelector('input'))
  await sleep(300)
  say('BULK: turning the column back off returns the chip ->', chipShown() === true)

  console.error = origError
  say('rendered bytes:', document.getElementById('root').innerHTML.length)
  if (errors.length) {
    say('--- errors ---')
    for (const e of [...new Set(errors)].slice(0, 10)) say(e)
  } else say('no errors captured')
  globalThis.__DONE__ = true
})()
