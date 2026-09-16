// Does the budget grid actually work? `npm run smoke` cannot say.
//
// Smoke renders under `renderToString`, where effects never fire — so this page
// only ever draws its LOADING branch and reports "ok, 946 bytes" for a grid that
// drew no rows. Every number, every input and every interaction on this page is
// behind a fetch, which means all of it is in the branch smoke does not reach.
//
// What is at risk, in the order the assertions run:
//
//   THE SECTION IS NOT TYPED     its Budget cell must be a derived figure, not
//                                an input. If it is an input, two grains are
//                                writable and they will disagree.
//   TOTALS FOLLOW THE FILTER     a totals row that keeps reporting the whole
//                                sheet while the body shows a third of it is a
//                                subtotal wearing a total's label.
//   A LEGACY BUDGET SURVIVES     `label` has 777 and no category row, so any
//                                filter that works category-first can lose it.
//   THE KEYBOARD WALKS WHAT IS   arrow keys must move through VISIBLE cells
//   ON SCREEN                    only; walking into a collapsed section types a
//                                budget into a row nobody can see.
//   A PASTE IS PREVIEWED         and lands on the cells below the one pasted on,
//                                skipping what is not a number instead of
//                                writing it as zero.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import ArtistBudgetSheet from '../src/pages/ArtistBudgetSheet'
import { calls, SHEET } from './budgetsheet-api-stub.js'
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
const type = (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(el, value)
  el.dispatchEvent(new window.Event('input', { bubbles: true }))
}
const blur = (el) => {
  el.dispatchEvent(new window.FocusEvent('blur', { bubbles: false }))
  el.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }))
}
const key = (el, k, opts = {}) => el.dispatchEvent(
  new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }))

// The grid is the FIRST table on the page (the open-invoice list is the second).
const grid = () => all('table')[0]
const bodyRows = () => [...grid().querySelectorAll('tbody tr')]
const rowFor = (label) => bodyRows().find((tr) => {
  const first = tr.querySelector('td')
  return first && textOf(first).replace(/\s*(unplanned|over-committed|retired|legacy)\s*/g, '').trim() === label
})
// A release row's first cell carries the title PLUS its date and what the
// marketing sheet planned, so an exact match finds nothing.
const rowStarting = (label) => bodyRows().find((tr) => {
  const first = tr.querySelector('td')
  return first && textOf(first).startsWith(label)
})
const cells = (tr) => [...tr.querySelectorAll('td')].map(textOf)
// Column order: label, budget, spent, open, committed, variance, %, actions
const COL = { budget: 1, spent: 2, open: 3, committed: 4, variance: 5, pct: 6 }
const colOf = (label, col) => cells(rowFor(label))[COL[col]]
const footCells = () => [...grid().querySelectorAll('tfoot td')].map(textOf)
const inputIn = (label) => rowFor(label)?.querySelector('input')
const money = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const pasteInto = (el, text) => {
  const ev = new window.Event('paste', { bubbles: true, cancelable: true })
  ev.clipboardData = { getData: () => text }
  el.dispatchEvent(ev)
}

const buttonSaying = (re) => all('button').find((b) => re.test(textOf(b)))
// BY CONTENT, not by position. `all('select')[0]` was the filter until a
// Group-by control was added ahead of it in the toolbar, and every filter
// assertion then silently drove the wrong one.
const selectWithOption = (v) => all('select').find((x) => [...x.options].some((o) => o.value === v))
const selectEl = () => selectWithOption('budgeted')
const grainEl = () => selectWithOption('release')
const setSelect = (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
  setter.call(el, value)
  el.dispatchEvent(new window.Event('change', { bubbles: true }))
}

async function main() {
  host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  root.render(
    <Catch>
      <ThemeProvider>
        <ToastProvider>
          <MemoryRouter initialEntries={['/artist-budgets/demoartist']}>
            <Routes>
              <Route path="/artist-budgets/:artistKey" element={<ArtistBudgetSheet />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </ThemeProvider>
    </Catch>
  )
  await sleep(600)

  const page = () => textOf(host)

  say('\nRENDER')
  assert('the page rendered something at all', host.innerHTML.length > 3000)
  assert('no error was thrown', errors.length === 0)
  if (errors.length) for (const e of errors.slice(0, 4)) say('     ' + e)
  assert('the artist is named', /Demo Artist/.test(page()))
  assert('the grid has all six money columns',
    ['Budget', 'Spent', 'Open', 'Committed', 'Variance']
      .every((h) => new RegExp(h).test(textOf(grid().querySelector('thead')))))

  say('\nTHE SECTION IS THE SUM, AND IS NOT TYPED')
  const campaign = rowFor('Campaign & promotion')
  assert('the section row renders', !!campaign)
  assert('its budget is 4,000.00 — the sum of its categories',
    colOf('Campaign & promotion', 'budget') === '$4,000.00')
  assert('the section budget cell is NOT an input', campaign.querySelectorAll('input').length === 0)
  assert('a category budget IS an input', !!inputIn('Marketing'))
  assert('and holds the stored number', inputIn('Marketing').value === '3000')

  say('\nVARIANCE MEASURES SPEND, OVER-COMMITTED IS A SEPARATE FACT')
  // 4,000 budget, 3,750 spent, 300 open. Inside budget on spend, over it once
  // the open invoices are paid — the one case where the two disagree.
  assert('variance is positive', colOf('Campaign & promotion', 'variance') === '$250.00')
  assert('and the row still says over-committed', /over-committed/.test(textOf(campaign)))
  assert('a category with spend and no budget says unplanned',
    colOf('Distribution', 'variance') === 'unplanned')
  assert('it does not print minus its own spend',
    !/-\$250|\$-250/.test(colOf('Distribution', 'variance')))
  assert('percent is spent over budget', colOf('Marketing', 'pct') === '117%')

  say('\nA CATEGORY CARRIES ITS OWN OPEN')
  assert('Marketing open is 200', colOf('Marketing', 'open') === '$200.00')
  assert('Marketing committed is 3,700', colOf('Marketing', 'committed') === '$3,700.00')
  assert('a category with no money reads as dashes, not zeros',
    colOf('Recording', 'spent') === '—')

  say('\nTHE LEGACY SECTION BUDGET IS VISIBLE AND LABELLED')
  assert('the section renders', !!rowFor('Running the label'))
  assert('its budget is the legacy figure', colOf('Running the label', 'budget') === '$777.00')
  assert('and a row underneath says where it came from',
    /\(section-level budget\)/.test(textOf(grid())))
  assert('marked legacy', /legacy/.test(textOf(grid())))

  say('\nTHE TOTALS ROW')
  const foot = footCells()
  assert('budget totals 5,277.00', foot[COL.budget] === '$5,277.00')
  assert('spent totals 4,350.00', foot[COL.spent] === '$4,350.00')
  assert('open totals 300.00', foot[COL.open] === '$300.00')
  assert('committed totals 4,650.00', foot[COL.committed] === '$4,650.00')
  assert('and it equals the sheet total the server sent',
    foot[COL.budget] === '$' + money(SHEET.totals.budget))
  assert('it is not labelled filtered at rest', !/filtered/.test(foot[0]))

  say('\nA FILTER MOVES THE TOTALS ROW WITH IT')
  setSelect(selectEl(), 'budgeted')
  await sleep(150)
  assert('an unbudgeted category is gone', !rowFor('Distribution'))
  assert('a budgeted one stays', !!rowFor('Marketing'))
  const ffoot = footCells()
  // 3,000 + 1,000 + 500 budgeted, plus the 777 legacy that belongs to no
  // category and therefore no filter.
  assert('budget follows the filter', ffoot[COL.budget] === '$5,277.00')
  assert('spent follows the filter — 3,700, not the sheet\'s 4,350',
    ffoot[COL.spent] === '$3,700.00')
  assert('the row says it is filtered', /filtered/.test(ffoot[0]))
  assert('and the page says how much of the sheet it covers',
    /of 7 categories this filter shows/.test(page()))
  assert('while still quoting the whole sheet for reference',
    /\$5,277\.00 budget against \$4,350\.00 spent/.test(page()))
  assert('the legacy budget was NOT lost to the filter', !!rowFor('Running the label'))

  setSelect(selectEl(), 'all')
  await sleep(150)
  assert('clearing the filter restores every row', !!rowFor('Distribution'))
  assert('and the totals row drops the filtered label', !/filtered/.test(footCells()[0]))

  say('\nSORTING')
  // By budget the campaign section leads (4,000); Marketing leads its own
  // categories either way, so the assertion is on a pair that DISAGREES:
  // Advertisements has 1,000 budget and 0 spent, Distribution 0 and 250.
  const order = () => bodyRows().map((tr) => textOf(tr.querySelector('td'))
    .replace(/\s*(unplanned|over-committed|retired|legacy)\s*/g, '').trim())
  const before = order()
  assert('at rest, Advertisements precedes Distribution (catalog order)',
    before.indexOf('Advertisements') < before.indexOf('Distribution'))
  click([...grid().querySelectorAll('thead button')].find((b) => /Spent/.test(textOf(b))))
  await sleep(150)
  const bySpent = order()
  assert('sorted by spend, Distribution (250) now precedes Advertisements (0)',
    bySpent.indexOf('Distribution') < bySpent.indexOf('Advertisements'))
  assert('Marketing (3,500) still leads its section',
    bySpent.indexOf('Marketing') < bySpent.indexOf('Distribution'))
  assert('a reset control appears', !!buttonSaying(/Sorted by Spent/))
  click(buttonSaying(/Sorted by Spent/))
  await sleep(150)
  assert('resetting restores catalog order',
    order().indexOf('Advertisements') < order().indexOf('Distribution'))

  say('\nTYPING IN A CELL')
  const mk = inputIn('Marketing')
  mk.focus()
  type(mk, '3300')
  // React binds onBlur to the bubbling `focusout`, not to `blur` — a
  // non-bubbling FocusEvent never reaches the root listener and the save that
  // this whole section is about silently does not run.
  blur(mk)
  await sleep(200)
  const wrote = calls.put.find((c) => /\/artist-budgets\/demoartist\/category$/.test(c.url))
  assert('blurring PUTs the cell', !!wrote)
  assert('it names the category', wrote?.body?.category === 'Marketing')
  assert('and sends a number, not the typed string', wrote?.body?.amount === 3300)

  say('\nESCAPE REVERTS AND WRITES NOTHING')
  const adv = inputIn('Advertisements')
  adv.focus()
  // AFTER the focus: jsdom blurs whatever was focused before, which fires the
  // previous cell's save. Taking the baseline earlier counts that write here.
  const putsBefore = calls.put.length
  type(adv, '9999')
  key(adv, 'Escape')
  await sleep(120)
  assert('the cell went back to what was stored', inputIn('Advertisements').value === '1000')
  assert('and nothing was written', calls.put.length === putsBefore)

  say('\nTHE KEYBOARD WALKS THE VISIBLE CELLS')
  const first = inputIn('Marketing')
  first.focus()
  key(first, 'ArrowDown')
  await sleep(80)
  assert('down moves to the next category',
    document.activeElement === inputIn('Advertisements'))
  key(document.activeElement, 'ArrowDown')
  await sleep(80)
  assert('and on to the third', document.activeElement === inputIn('Distribution'))
  key(document.activeElement, 'ArrowDown')
  await sleep(80)
  assert('across a section boundary, into the next section',
    document.activeElement === inputIn('Recording'))
  key(document.activeElement, 'ArrowUp')
  await sleep(80)
  assert('up walks back', document.activeElement === inputIn('Distribution'))
  key(document.activeElement, 'Tab')
  await sleep(80)
  assert('Tab moves forward too', document.activeElement === inputIn('Recording'))

  say('\nA COLLAPSED SECTION IS NOT WALKED INTO')
  click([...rowFor('Making the record').querySelectorAll('button')][0])
  await sleep(150)
  assert('its categories are hidden', !rowFor('Recording'))
  assert('the section row is still there', !!rowFor('Making the record'))
  const d = inputIn('Distribution')
  d.focus()
  key(d, 'ArrowDown')
  await sleep(80)
  assert('down from the last visible cell of a section skips the hidden ones',
    document.activeElement === inputIn('Advance'))
  click([...rowFor('Making the record').querySelectorAll('button')][0])
  await sleep(150)
  assert('expanding brings them back', !!rowFor('Recording'))

  say('\nDRILLING A CATEGORY')
  assert('the expense rows are hidden at rest', !/Marquee Media/.test(page()))
  const drill = [...rowFor('Marketing').querySelectorAll('button')]
    .find((b) => /items?$/.test(textOf(b)))
  assert('the item count is a button', !!drill)
  click(drill)
  await sleep(150)
  assert('a paid expense appears', /Marquee Media/.test(textOf(grid())))
  assert('with its state', /paid, not confirmed|confirmed/.test(textOf(grid())))
  const openRow = bodyRows().find((tr) => /Late Vendor/.test(textOf(tr)))
  assert('an unpaid one appears too', !!openRow)
  assert('and its amount is in the OPEN column, not Spent',
    cells(openRow)[COL.spent] === '' && cells(openRow)[COL.open] === '$200.00')
  click(drill)
  await sleep(150)
  assert('clicking again hides them', !/Marquee Media/.test(textOf(grid())))

  say('\nPASTING A COLUMN FROM EXCEL')
  const target = inputIn('Marketing')
  target.focus()
  pasteInto(target, '1,500.00\n$2,000\nn/a\n250\n')
  await sleep(200)
  assert('a preview opens rather than writing', /Paste 3 budgets/.test(page()))
  const modal = all('div.fixed')[0]
  assert('it shows the first target', /Marketing/.test(textOf(modal)))
  // Read off the MODAL, not the page: the grid behind it names every section,
  // so a blank sub-label here passes against `page()`. It was blank — the
  // preview was reading `label` off a category, which carries `section`.
  assert('and names the section each cell is in',
    /Campaign & promotion/.test(textOf(modal)))
  assert('with the value it would replace', /\$3,000\.00/.test(textOf(modal)))
  assert('a non-number is reported as skipped', /skipped — not a number/.test(page()))
  assert('and nothing has been written yet',
    !calls.put.some((c) => /\/categories$/.test(c.url)))
  const apply = buttonSaying(/^Paste 3$/)
  assert('the confirm button counts only the writable cells', !!apply)
  click(apply)
  await sleep(250)
  const bulk = calls.put.find((c) => /\/artist-budgets\/demoartist\/categories$/.test(c.url))
  assert('confirming PUTs the bulk endpoint', !!bulk)
  assert('three cells, not four', bulk?.body?.items?.length === 3)
  assert('the first lands where it was pasted',
    bulk?.body?.items?.[0]?.category === 'Marketing' && bulk.body.items[0].amount === 1500)
  assert('the currency symbol was parsed off the second',
    bulk?.body?.items?.[1]?.category === 'Advertisements' && bulk.body.items[1].amount === 2000)
  assert('the fourth value skipped past the bad row onto the fourth CELL',
    bulk?.body?.items?.[2]?.category === 'Recording' && bulk.body.items[2].amount === 250)
  assert('Distribution — the cell the bad row landed on — was not written',
    !bulk?.body?.items?.some((i) => i.category === 'Distribution'))

  say('\nGROUPING BY RELEASE')
  const grainSel = grainEl()
  assert('a group-by control exists', !!grainSel)
  assert('offering category and release',
    grainSel && [...grainSel.options].map((o) => o.value).join(',') === 'category,release')
  setSelect(grainSel, 'release')
  await sleep(200)
  assert('the releases are the rows now', !!rowStarting('Red Eye') && !!rowStarting('Last Call'))
  assert('and the categories are gone', !rowFor('Marketing'))
  assert('the first column is relabelled', /Release/.test(textOf(grid().querySelector('thead'))))
  // The budget cell is an INPUT, so the td has no text — read the value.
  assert('a release carries its own budget',
    rowStarting('Red Eye').querySelector('input')?.value === '2000')
  assert('and its own spend', cells(rowStarting('Red Eye'))[COL.spent] === '$1,800.00')
  assert('an unbudgeted release reads unplanned', cells(rowStarting('Last Call'))[COL.variance] === 'unplanned')
  assert('what the marketing sheet planned is shown beside it, not merged',
    /sheet \$2,500\.00/.test(textOf(rowStarting('Red Eye'))))
  assert('a release budget cell is editable', !!rowStarting('Red Eye').querySelector('input'))

  say('\nTHE MONEY WITH NO RELEASE IS NOT HIDDEN')
  const resid = bodyRows().find((tr) => /No release named/.test(textOf(tr)))
  assert('the residual row is on screen', !!resid)
  assert('carrying the spend that names no release', /\$2,100\.00/.test(textOf(resid)))
  assert('and it is NOT editable — a residual is not somewhere to plan',
    resid && resid.querySelectorAll('input').length === 0)
  // 1,800 + 450 + 2,100 = 4,350, which is EXACTLY what the category grain
  // reported a few assertions ago. That equality is what makes this a partition
  // of the artist rather than a view of part of them — and it is the one number
  // that would move if the residual were dropped.
  assert('the totals row adds the releases AND the residual',
    footCells()[COL.spent] === '$4,350.00')
  // SPENT is the same under both grains — they partition the same money — so
  // that assertion alone cannot tell which grain the footer is reading. BUDGET
  // is what differs (5,277 by category, 2,000 by release), and it is the only
  // thing here that catches a footer left reading the other grain. Found by
  // breaking it and watching the harness stay green.
  assert('and the budget is the RELEASE grain\'s, not the category grain\'s',
    footCells()[COL.budget] === '$2,000.00')

  say('\nTWO PARTITIONS, STATED')
  assert('the page says the two grains disagree',
    /planned .* by category and .* by release/i.test(page()))
  assert('naming both figures', /\$5,277\.00/.test(page()) && /\$2,000\.00/.test(page()))

  setSelect(grainSel, 'category')
  await sleep(200)
  assert('switching back restores the categories', !!rowFor('Marketing'))
  assert('and the totals row goes back to the category total',
    footCells()[COL.budget] === '$5,277.00')

  say('\nTHE OPEN INVOICE WORKLIST IS STILL THERE')
  assert('it lists the oldest first', /Late Vendor/.test(page()))
  assert('and totals what is still to pay', /STILL TO PAY/.test(page()))
  assert('committed is spelled out', /Committed — spent plus open/.test(page()))

  say('\nno late errors -> ' + (errors.length === 0))
  if (errors.length) for (const e of errors.slice(0, 6)) say('     ' + e)
  say('\nDONE')
}

// The runner polls this rather than sitting out its whole timeout.
const finish = () => { globalThis.__DONE__ = true }
main()
  .catch((e) => { console.log('HARNESS THREW: ' + e.message); console.log('DONE') })
  .finally(finish)
