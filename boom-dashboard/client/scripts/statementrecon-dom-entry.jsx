// Does the statement library actually print a reconciliation that adds up?
//
// `npm run smoke` renders BkStatements under renderToString, where effects never
// fire — so it renders in its LOADING state and reports "ok, 686 bytes" for a
// library that never drew a single month. Every figure this change adds lives on
// a data row behind two disclosures, so a green smoke run says nothing at all
// about it.
//
// What this proves, against fixtures whose answers are known in advance
// (scripts/statementrecon-api-stub.js):
//
//   TOTAL     the page strip reduces over every statement
//   MONTH     each month reduces over the statements rendered beneath IT, and
//             two months with different answers print different numbers
//   STATEMENT its own bar is the same reduction over one statement
//   PARTITION accounted + left + excluded is exactly the statement's lines, and
//             the money on those lines sums to the total the panel prints
//   OLD       the columns this replaces (89%, "8/9") are nowhere on the page
//   LINKS     every figure that links lands on the filter holding those rows
//   GATE      the unlock sentence names its own condition, not the header's
//   FAILURE   a dead /reconciliation renders as UNKNOWN — never "clear", never
//             "0 left", never 100%. That is the difference between "we don't
//             know" and "the work is done", and this page has shipped the wrong
//             one before.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import BkStatements from '../src/pages/BkStatements'
import { control, RECON } from './statementrecon-api-stub.js'

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
// NOT `document.body.textContent`, which concatenates sibling elements with no
// separator: a row of four <span>s renders "May 2026$30,000.0027%" and an
// assertion written against what the screen shows never matches. jsdom has no
// innerText, so the boundary is reinserted here.
const text = () => {
  const out = []
  const walk = (n) => {
    if (n.nodeType === 3) return out.push(n.nodeValue)
    if (n.nodeType !== 1) return
    out.push(' ')
    for (const c of n.childNodes) walk(c)
    out.push(' ')
  }
  walk(document.body)
  return out.join('').replace(/\s+/g, ' ').trim()
}
// The same extraction, scoped to one element — an assertion about a month row
// has to read that row, not the page it sits on.
const elText = (el) => {
  if (!el) return ''
  const out = []
  const walk = (n) => {
    if (n.nodeType === 3) return out.push(n.nodeValue)
    if (n.nodeType !== 1) return
    out.push(' ')
    for (const c of n.childNodes) walk(c)
    out.push(' ')
  }
  walk(el)
  return out.join('').replace(/\s+/g, ' ').trim()
}
const has = (re) => re.test(text())
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
// Find a clickable by the text it carries — the library has no test ids and
// adding them for a diagnostic would put scaffolding in shipped markup.
const byText = (sel, re) => [...document.querySelectorAll(sel)].find((e) => re.test((e.textContent || '').replace(/\s+/g, ' ')))

function mount() {
  const root = createRoot(document.getElementById('root'))
  root.render(<MemoryRouter initialEntries={['/bk/statements']}><Catch><BkStatements /></Catch></MemoryRouter>)
  return root
}

;(async () => {
  let root = mount()
  await sleep(700)

  say('BOOT: the library rendered ->', has(/Statements by month/))

  // ── 1. the page total ──────────────────────────────────────────────────────
  // 601 $20,000 + 602 $10,000 + 603 $1,000 in scope = $31,000.
  // accounted 3,000 + 5,000 + 1,000 = 9,000 → 29%. left 17,000 + 5,000 = 22,000.
  say('TOTAL: money out ->', has(/\$31,000\.00 out/))
  say('TOTAL: accounted for ->', has(/29% accounted for/))
  say('TOTAL: left ->', has(/\$22,000\.00 left/))
  say('TOTAL: unbooked deposits are counted, not summed into money out ->', has(/2 deposits unbooked/))

  // ── 2. the months disagree with each other, correctly ──────────────────────
  // May: 30,000 in scope, 8,000 accounted → 27%, 22,000 left.
  // April: 1,000 in scope, all of it accounted → 100%, clear.
  // Read each header off its OWN element. Against whole-page text a `.*` runs
  // clean through May into April's figures, so "May does not say 100%" matched
  // April's 100% and failed while the page was correct.
  const monthRow = (re) => byText('div[role="button"]', re)
  const mayText = elText(monthRow(/May 2026/))
  const aprText = elText(monthRow(/April 2026/))
  say('MONTH: May reads 27% ->', /27%/.test(mayText))
  say('MONTH: and $22,000.00 left ->', /\$22,000\.00 left/.test(mayText))
  say('MONTH: April reads 100% ->', /100%/.test(aprText))
  say('MONTH: and clear ->', /clear/.test(aprText))
  say('MONTH: a finished month and an unfinished one do NOT print the same number ->',
    !/100%/.test(mayText) && !/left/.test(aprText))

  // ── 3. into May, to the statement rows ────────────────────────────────────
  const may = byText('div[role="button"]', /May 2026/)
  say('OPEN: the May row is there ->', !!may)
  click(may)
  await sleep(400)
  // 601: 3,000 of 20,000 = 15%. 602: 5,000 of 10,000 = 50%.
  say('STATEMENT: BofA reads 15% ->', has(/15%/))
  say('STATEMENT: PayPal reads 50% ->', has(/50%/))
  say('STATEMENT: BofA prints its money out ->', has(/\$20,000\.00/))

  // ── 4. THE POINT: the old columns are gone ────────────────────────────────
  // The stub feeds matched=8, debits=9 (89%) for the very statement that is
  // 15% done. Either string on the page means a caller went back to the column.
  say('OLD: the "8/9" fraction is gone ->', !/8\/9/.test(text()))
  say('OLD: and so is the 89% it produced ->', !/89%/.test(text()))
  say('OLD: the months feed\'s own coverage (91%) is not printed either ->', !/91%/.test(text()))

  // ── 5. the breakdown ───────────────────────────────────────────────────────
  const toggle = [...document.querySelectorAll('button')]
    .find((b) => /Show what this statement has answered/.test(b.getAttribute('title') || ''))
  say('BREAKDOWN: a statement row offers the disclosure ->', !!toggle)
  click(toggle)
  await sleep(400)
  say('BREAKDOWN: money out and money in are separate headings ->', has(/Money out/) && has(/Money in/))
  say('BREAKDOWN: accounted for $3,000.00 ->', has(/Accounted for 3 \$3,000\.00/))
  say('BREAKDOWN: matched to an invoice $2,000.00 ->', has(/matched to an invoice 1 \$2,000\.00/))
  say('BREAKDOWN: creator payments are named, not folded into matched ->',
    has(/creator payments — no invoice exists 1 \$500\.00/))
  say('BREAKDOWN: left to match $17,000.00 ->', has(/Left to match 5 \$17,000\.00/))
  say('BREAKDOWN: booked-still-owed is the bulk of it ->',
    has(/booked, still owed an invoice 4 \$15,000\.00/))
  say('BREAKDOWN: no ledger entry at all $2,000.00 ->', has(/no ledger entry at all 1 \$2,000\.00/))
  say('BREAKDOWN: excluded is its own line, outside the percentages ->', has(/Excluded 1 \$900\.00/))
  say('BREAKDOWN: money in is booked and unbooked, never added to money out ->',
    has(/Booked to income 1 \$3,000\.00/) && has(/Not booked 2 \$250\.00/))

  // ── 6. the partition, asserted rather than eyeballed ──────────────────────
  // Every line of the statement is in exactly one bucket, so the three group
  // figures must be the statement itself — the property the server fixture
  // proves in SQL and this one proves in the pixels.
  const d = RECON[601].debits
  const accN = d.matched.n + d.creator.n + d.no_invoice_due.n
  const leftN = d.needs_invoice.n + d.open.n
  const total = Object.values(d).reduce((s, b) => s + b.n, 0)
  say(`PARTITION: ${accN} accounted + ${leftN} left + ${d.excluded.n} excluded = ${total} lines ->`,
    accN + leftN + d.excluded.n === total)
  const accV = d.matched.value + d.creator.value + d.no_invoice_due.value
  const leftV = d.needs_invoice.value + d.open.value
  say(`PARTITION: and the money out the panel prints is $${(accV + leftV).toLocaleString()} ->`,
    has(new RegExp(`Money out lines \\$${(accV + leftV).toLocaleString()}\\.00`)))

  // ── 7. every link lands on the rows it counted ────────────────────────────
  const hrefs = [...document.querySelectorAll('a[href*="bank-matching"]')].map((a) => a.getAttribute('href'))
  for (const [label, want] of [
    ['accounted for', '/bk/bank-matching?statement=601&filter=categorized'],
    ['left to match', '/bk/bank-matching?statement=601&filter=open'],
    ['needs invoice', '/bk/bank-matching?statement=601&filter=needs-invoice'],
    ['excluded', '/bk/bank-matching?statement=601&filter=dismissed'],
  ]) say(`LINKS: ${label} ->`, hrefs.includes(want))
  say('LINKS: no line links to a filter that would show a different set ->',
    !hrefs.some((h) => /filter=(matched|booked|all)\b/.test(h)))

  // ── 8. the unlock sentence names ITS condition, not the header's ──────────
  // 2 lines with no ledger entry across May; the 4 needing an invoice do not
  // block a close, and saying "22,000 left" here would promise that they do.
  say('GATE: names the lines that actually block it ->',
    has(/Reconcile unlocks when 2 lines with no ledger entry are resolved/))
  say('GATE: and says the needs-invoice pile does not ->',
    has(/4 booked lines still owed an invoice do not block it/))

  // ── 9. a dead request is UNKNOWN, never "done" ────────────────────────────
  root.unmount()
  await sleep(100)
  control.reconFails = true
  root = mount()
  await sleep(700)
  say('FAILURE: the library still renders ->', has(/Statements by month/))
  say('FAILURE: it claims no coverage at all ->', !/%/.test(text()))
  say('FAILURE: it does not say clear ->', !/clear/.test(text()))
  say('FAILURE: and it does not say anything is left, either ->', !/left/.test(text()))
  say('FAILURE: the old columns did not come back as a fallback ->', !/8\/9/.test(text()))

  say('rendered bytes:', (document.getElementById('root').innerHTML || '').length)
  say(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no errors captured')
  say('DONE')
  globalThis.__DONE__ = true
})()
