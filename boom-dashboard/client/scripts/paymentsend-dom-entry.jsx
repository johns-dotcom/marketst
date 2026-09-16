// "I sent the email but the row still says Send."
//
// Reproduces the exact sequence John hit on entry #1611 (2026-09-01): drop a
// proof on a paid invoice, then send the confirmation a few seconds later,
// while the delayed post-upload refetch is still in flight. The ledger recorded
// the send; the row on screen went back to offering "Send".
//
// The mechanism is a stale read winning, so the harness has to control WHEN the
// read lands — see the header of scripts/paymentsend-api-stub.js. The page's own
// 4s post-upload timer is left alone and waited out; what the harness widens is
// the RESPONSE latency, so the send lands in the middle of the window every run
// instead of most runs. The order under test:
//
//     upload ──▶ (refetch armed) ──▶ GET issued ──▶ send POST ──▶ send resolves
//                                        └────────── stale response lands ─────▶
//
// Asserts three things, in this order, because the first two are what stop a
// green result from being vacuous:
//
//   1. the row offers Send after the proof lands  (the setup is real)
//   2. the send POST goes out                     (the send happened)
//   3. the row STILL reads sent after the stale GET resolves  (the bug)
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import BkPayments from '../src/pages/BkPayments'
import { calls, state } from './paymentsend-api-stub.js'
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

createRoot(document.getElementById('root')).render(
  <MemoryRouter initialEntries={['/bk/payments']}>
    <ThemeProvider><ToastProvider><FxRatesProvider><BoomRepsProvider><CategoriesProvider>
      <Catch><BkPayments /></Catch>
    </CategoriesProvider></BoomRepsProvider></FxRatesProvider></ToastProvider></ThemeProvider>
  </MemoryRouter>
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const click = (el) => (el
  ? el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  : false)
// React 18 delegates onBlur to the native FOCUSOUT event (blur does not bubble,
// so React never sees a synthetic 'blur' dispatched at the node). Dispatching
// 'blur' here silently did nothing and made every edit assertion read false.
const blur = (el) => el && el.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }))
const buttons = () => [...document.querySelectorAll('button')]
const all = (sel) => [...document.querySelectorAll(sel)]
// React tracks the previous value on the DOM node, so assigning `.value`
// directly makes it ignore the change event. Go through the native setter.
const setValue = (el, v) => {
  const proto = el.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
  el.dispatchEvent(new window.Event('input', { bubbles: true }))
}
const btn = (re) => buttons().find((b) => re.test((b.textContent || '').trim()))
const bodyText = () => document.body.textContent || ''
const say = (...a) => console.log(...a)

// The page's post-upload refetch timer (BkPayments hardcodes 4000ms). The
// harness waits it out rather than changing it — a test that shortens the thing
// it is testing is testing something else.
const UPLOAD_WAIT_MS = Number(process.env.UPLOAD_WAIT_MS || 4000)
const SCENARIO = process.env.SCENARIO || 'race'
// Kept in step with the stub, which is where the latency is decided.
const GET_LATENCY_MS = Number(process.env.GET_LATENCY_MS || 2500)

// React tracks a controlled input's value, so it has to be set through the
// prototype descriptor or the synthetic onChange never fires.
const type = (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(el, value)
  el.dispatchEvent(new window.Event('input', { bubbles: true }))
}

;(async () => {
  // The first list load pays the stub's own latency before anything is on screen.
  await sleep(GET_LATENCY_MS + 900)
  if (SCENARIO !== 'queue') {
    say('SETUP: the invoice is on screen ->', bodyText().includes('Salmon Studios Limited'))
  }

  // ── The queue: priority ordering, and gathering a vendor ─────────────────
  //
  // Neither is reachable by `npm run smoke`, which renders one page with an
  // empty list: an ordering has nothing to order and a group header has
  // nothing to head.
  if (SCENARIO === 'queue') {
    // Group headers are the only <td colspan="12"> on the page.
    const headers = () => all('td[colspan="12"]').map((td) => td.textContent.trim())
    // Row identity is read off the invoice number, which is unique per row and
    // appears nowhere else on the page.
    const order = () => {
      const text = bodyText()
      // Every invoice number in the QUEUE fixture. NOT generic — a row added to
      // the stub and not listed here is simply invisible to every ordering
      // assertion, which reads as "the row did not render".
      return ['FL-1', 'AC-1', 'BM-1', 'EU-1', 'CO-1', 'DE-1', 'AC-2', 'AC-3', 'EC-1',
              'QU-1', 'RO-1', 'TH-1']
        .map((n) => [n, text.indexOf(n)])
        .filter(([, i]) => i >= 0)
        .sort((a, b) => a[1] - b[1])
        .map(([n]) => n)
    }
    const setSelect = (el, v) => {
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(el, v)
      el.dispatchEvent(new window.Event('change', { bubbles: true }))
    }
    const selectWith = (optionText) => all('select').find((sel) =>
      [...sel.options].some((o) => o.textContent.trim() === optionText))
    // Scope is set by the stat cards now, so "show everything" is the ALL
    // INVOICES card rather than an 'All' chip.
    const setQuick = (label) => click(buttons().find((b) =>
      new RegExp('^' + label.toUpperCase()).test((b.textContent || '').trim())))

    say('SETUP: every fixture row is on screen ->', order().length === 12, `(${order().length})`)

    // ── Priority ordering ────────────────────────────────────────────────
    say('SORT: Priority is the default ->',
      !!selectWith('Priority') && selectWith('Priority').value === 'Priority')

    // Headers carry the group's row count after the label ("Rush1 invoice"),
    // which is the shared header's doing, not the band's.
    const bands = headers().map((h) => h.replace(/\d+ invoices?$/, '').trim())
    const EXPECTED = ['Rush · overdue', 'Rush', 'Overdue', 'Due within 7 days', 'Scheduled', 'On hold', 'Paid']
    say('BANDS: every band is labelled, in order ->',
      JSON.stringify(bands) === JSON.stringify(EXPECTED), `(${JSON.stringify(bands)})`)

    const seq = order()
    say('ORDER: the rushed-and-overdue invoices lead ->',
      seq[0] === 'FL-1' && seq[1] === 'AC-1', `(${seq.join(' ')})`)
    say('ORDER: inside a band the older obligation is first ->',
      seq.indexOf('FL-1') < seq.indexOf('AC-1'))
    // The discriminating pair: due-date-ascending would invert this.
    say('ORDER: a rush not yet due outranks an overdue invoice ->',
      seq.indexOf('BM-1') < seq.indexOf('CO-1'))
    // Stated structurally rather than by index: every parked row must fall below
    // every active one. Pinning EC-1 to the last slot made this assertion a
    // hostage to the fixture's size, which is not the property under test.
    const PARKED = ['AC-3', 'EC-1', 'TH-1']
    const lastActive = Math.max(...seq.filter((n) => !PARKED.includes(n)).map((n) => seq.indexOf(n)))
    const firstParked = Math.min(...PARKED.map((n) => seq.indexOf(n)))
    say('ORDER: held and paid rows sink below the queue ->', firstParked > lastActive,
      `(last active ${lastActive}, first parked ${firstParked})`)

    // Proof the assertion can fail: under Due Date the SAME page must invert
    // that pair. Without this, a comparator that ignored bands entirely could
    // still be passing everything above by luck of the fixture's due dates.
    const sortSel = selectWith('Priority')
    setSelect(sortSel, 'Due Date')
    await sleep(300)
    const byDate = order()
    say('CONTROL: under Due Date the overdue invoice comes first instead ->',
      byDate.indexOf('CO-1') < byDate.indexOf('BM-1'), `(${byDate.join(' ')})`)
    say('CONTROL: and the band headers are gone ->', headers().length === 0)
    setSelect(sortSel, 'Priority')
    await sleep(300)

    // ── Group by Vendor ──────────────────────────────────────────────────
    const groupSel = selectWith('Group by Vendor')
    say('GROUP: the option is offered ->', !!groupSel)
    setSelect(groupSel, 'Group by Vendor')
    await sleep(300)

    const vHeaders = headers()
    say('GROUP: one header per vendor ->', vHeaders.length === 10, `(${vHeaders.length})`)
    const acme = vHeaders.find((h) => h.startsWith('Acme Audio'))
    say('GROUP: the vendor holding three rows is gathered into one ->', !!acme, `(${acme})`)
    // $1000 + $500. The held $300 is NOT in it.
    say('GROUP: the total counts the payable rows ->', !!acme && /\$1,500\.00/.test(acme))
    say('GROUP: and excludes the held one ->', !!acme && !/\$1,800\.00/.test(acme))
    say('GROUP: the hold is named rather than dropped silently ->', !!acme && /1 on hold/.test(acme))
    say('GROUP: it reports two open invoices ->', !!acme && /2 open invoices/.test(acme))
    say('GROUP: vendors are still ordered by priority ->',
      vHeaders[0].startsWith('Fathom Live') && vHeaders[1].startsWith('Acme Audio'))

    // ── Pay all ──────────────────────────────────────────────────────────
    const payAll = buttons().find((b) => /Pay all \(2\)/.test((b.textContent || '').trim()))
    say('PAY ALL: the vendor header offers it ->', !!payAll)
    say('PAY ALL: single-invoice vendors do not ->',
      buttons().filter((b) => /Pay all/.test(b.textContent || '')).length === 1)
    click(payAll)
    await sleep(400)
    // Scoped to the dialog, not the page. Read off bodyText() the $1,500 check
    // passes on the vendor HEADER's total even when the dialog is showing
    // something else — verified: sweeping the held row in leaves the page text
    // matching and only the invoice COUNT moves.
    const modalEl = all('h3').find((h) => /Pay these together/.test(h.textContent || ''))
    const modal = modalEl ? modalEl.parentElement.textContent : ''
    say('PAY ALL: the batch dialog opened ->', !!modalEl)
    say('PAY ALL: on the payable total ->', /\$1,500\.00/.test(modal))
    say('PAY ALL: naming the vendor ->', /to Acme Audio/.test(modal))
    say('PAY ALL: over two invoices, not three ->', /2 invoices/.test(modal))
    const oneP = all('input[type="checkbox"]').find((c) => {
      const lbl = c.closest('label')
      return lbl && /ONE payment/.test(lbl.textContent || '')
    })
    say('PAY ALL: the one-payment declaration is offered ->', !!oneP)
    say('PAY ALL: and defaulted on for a single vendor ->', !!oneP && oneP.checked === true)
    // ── The chrome ───────────────────────────────────────────────────────
    // Close the batch dialog and drop the selection it made. Without this the
    // selection accumulates across sections and the later count is Pay-all's
    // two plus the pending one.
    click(buttons().find((b) => /^Cancel$/.test((b.textContent || '').trim())))
    await sleep(250)
    click(buttons().find((b) => /^Clear$/.test((b.textContent || '').trim())))
    await sleep(250)
    say('RESET: the dialog is closed ->', !all('h3').some((h) => /Pay these together/.test(h.textContent || '')))
    say('RESET: nothing is selected ->', !buttons().some((b) => /^Clear$/.test((b.textContent || '').trim())))
    setSelect(groupSel, 'No grouping')
    await sleep(300)

    // The four chips that repeated the stat cards are gone. Checked against
    // BUTTONS only — 'Unpaid' and 'Paid' are also <option>s in the status
    // select, which is not what was removed.
    const chipTexts = buttons().map((b) => (b.textContent || '').trim())
    say('CHROME: the duplicated scope chips are gone ->',
      !chipTexts.includes('All') && !chipTexts.includes('Unpaid') &&
      !chipTexts.includes('Due Soon') && !chipTexts.includes('Overdue'))
    say('CHROME: the three workflow chips remain ->',
      ['Rush', 'Hold', 'Multi-invoice'].every((t) => chipTexts.some((c) => c.startsWith(t))))

    // A card is now a filter, so its number is a promise about the list. The
    // Overdue card counts rushed-overdue rows too (isOverdue && !on_hold), so
    // this is 3, not the 1 that "overdue but not rush" would give.
    const card = buttons().find((b) => /^OVERDUE/.test((b.textContent || '').trim()))
    say('CARDS: the stat card is a control ->', !!card)
    const claimed = card && [...card.querySelectorAll('div')]
      .map((d) => d.textContent.trim())
      .find((t) => /^\d+ invoices$/.test(t))?.split(' ')[0]
    say('CARDS: it states a count ->', !!claimed, `(${claimed})`)
    click(card)
    await sleep(350)
    const landed = order()
    say('CARDS: clicking it filters the list ->', landed.length === Number(claimed),
      `(claimed ${claimed}, listed ${landed.length}: ${landed.join(' ')})`)
    say('CARDS: to exactly the overdue rows ->',
      JSON.stringify(landed.sort()) === JSON.stringify(['AC-1', 'CO-1', 'FL-1']))

    // One export control, two formats behind it.
    const exportBtn = buttons().find((b) => /^Export/.test((b.textContent || '').trim()))
    say('EXPORT: there is one export button ->',
      !!exportBtn && buttons().filter((b) => /^(Export|CSV|Excel)/.test((b.textContent || '').trim())).length === 1)
    click(exportBtn)
    await sleep(250)
    const menu = buttons().map((b) => (b.textContent || '').trim())
    say('EXPORT: the menu offers CSV ->', menu.some((t) => /^CSV/.test(t)))
    say('EXPORT: and Excel ->', menu.some((t) => /^Excel/.test(t)))
    click(exportBtn)
    await sleep(200)

    setQuick('All')
    await sleep(300)
    // The CC-the-rep control moved off the filter row; it must still exist
    // exactly once, and the bulk send must not be rendered twice.
    const ccLabels = all('label').filter((l) => /CC rep/.test(l.textContent || ''))
    say('CC: the control exists exactly once ->', ccLabels.length === 1, `(${ccLabels.length})`)
    say('CC: it is not among the filter controls ->',
      !!ccLabels[0] && !ccLabels[0].closest('div')?.querySelector('input[placeholder^="Search payee"]'))
    say('CC: it defaults OFF ->',
      !!ccLabels[0] && ccLabels[0].querySelector('input[type="checkbox"]').checked === false)

    const pendingLink = buttons().find((b) => /^Pending 1$/.test((b.textContent || '').trim()))
    say('SELECTION: the pending link reports one ->', !!pendingLink)
    click(pendingLink)
    await sleep(300)
    const sendBtns = buttons().filter((b) => /Send 1 Selected/i.test((b.textContent || '').trim()))
    say('SEND: the bulk button renders exactly once ->', sendBtns.length === 1, `(${sendBtns.length})`)
    const summary = all('span').map((x) => x.textContent.trim()).filter((t) => /selected$/i.test(t))
    say('SELECTION: the count reads back ->', summary.includes('1 selected'), `(${JSON.stringify(summary)})`)

    // ── What the page knows and used to keep to itself ───────────────────
    setQuick('All')
    await sleep(300)
    const chips = buttons().map((b) => (b.textContent || '').trim())
    // ── The chips carry MONEY, and it is a promise about the list ───────────
    //
    // John, 2026-09-15: "I want to be able to see the amount that is labeled
    // rush, amount labeled as hold." A count says how many lines are waiting;
    // it does not say whether Rush is $4,000 or $400,000.
    //
    // Fixture: Rush is FL-1 $900 + AC-1 $1,000 + BM-1 $2,000 + EU-1 €1,000,
    // and €1,000 at 0.92 is $1,086.96 — so the chip must read $4,987, NOT the
    // $4,900 an unconverted sum gives and NOT the $3,900 of dropping it.
    // Hold is AC-3 $300 alone.
    const chipText = (label) => chips.find((c) => new RegExp(`^${label}`).test(c)) || ''
    say('CHIPS: Rush shows its money, converted ->',
      /^Rush\s*\$4,987\s*4$/.test(chipText('Rush')), `(${chipText('Rush')})`)
    say('CHIPS: and it is NOT the unconverted sum ->', !/\$4,900/.test(chipText('Rush')))
    say('CHIPS: nor the foreign row dropped ->', !/\$3,900/.test(chipText('Rush')))
    say('CHIPS: Hold shows its money ->',
      /^Hold\s*\$300\s*1$/.test(chipText('Hold')), `(${chipText('Hold')})`)
    // A chip has no room for "$3,900.00 + €1,000.00", so the native breakdown
    // is disclosed on hover rather than not at all — a converted figure with no
    // way to see what it is made of reads as dollars.
    const rushBtn = buttons().find((b) => /^Rush/.test((b.textContent || '').trim()))
    const rushTitle = rushBtn?.getAttribute('title') || ''
    say('CHIPS: the tooltip names the native currencies ->',
      /\$3,900\.00 \+ €1,000\.00/.test(rushTitle), `(${rushTitle})`)
    // All-USD set: there is nothing to disclose, so it must not pretend there is.
    const holdTitle = buttons().find((b) => /^Hold/.test((b.textContent || '').trim()))?.getAttribute('title') || ''
    say('CHIPS: an all-USD chip discloses no breakdown ->',
      /^Hold: 1 invoice$/.test(holdTitle), `(${holdTitle})`)

    // THE contract: the number on the chip describes the rows the chip opens.
    click(buttons().find((b) => /^Hold/.test((b.textContent || '').trim())))
    await sleep(350)
    say('CHIPS: Hold opens exactly the row its money counted ->',
      JSON.stringify(order()) === JSON.stringify(['AC-3']), `(${order().join(' ')})`)
    click(buttons().find((b) => /^Hold/.test((b.textContent || '').trim())))
    await sleep(300)

    click(buttons().find((b) => /^Rush/.test((b.textContent || '').trim())))
    await sleep(350)
    say('CHIPS: Rush opens exactly the four it counted ->',
      JSON.stringify(order().sort()) === JSON.stringify(['AC-1', 'BM-1', 'EU-1', 'FL-1']),
      `(${order().join(' ')})`)
    click(buttons().find((b) => /^Rush/.test((b.textContent || '').trim())))
    await sleep(300)

    say('BLOCKED: the chip exists and counts two ->',
      chips.some((c) => /^Blocked\s*\$1,160\s*2$/.test(c)), `(${chips.filter((c) => /^Blocked/.test(c))})`)

    click(buttons().find((b) => /^Blocked/.test((b.textContent || '').trim())))
    await sleep(350)
    const blocked = order()
    say('BLOCKED: it filters to exactly the two stuck rows ->',
      JSON.stringify(blocked.sort()) === JSON.stringify(['QU-1', 'RO-1']), `(${blocked.join(' ')})`)
    const blockedText = bodyText()
    say('BLOCKED: and NAMES the reason on the row ->',
      /NO PAYMENT METHOD/.test(blockedText) && /NO VENDOR EMAIL/.test(blockedText))

    // Paid, no proof: the Send button is absent, and that has to be legible.
    setQuick('PAID')
    await sleep(350)
    const paidText = bodyText()
    say('PROOF: the paid row with no proof says so ->', /NEEDS PROOF/.test(paidText))
    say('PROOF: the row WITH proof still offers Send ->',
      buttons().some((b) => /^Send$/.test((b.textContent || '').trim())))

    // ── W-9, the vendor question ─────────────────────────────────────────
    setQuick('ALL')
    await sleep(300)
    // Borough is covered by a form filed on ANOTHER invoice — has_w9 false,
    // w9_entry_id set. The naive row-level flag calls this missing.
    const openPanel = async (invNo) => {
      const row = all('tr').find((tr) => (tr.textContent || '').includes(invNo))
      const chev = row && [...row.querySelectorAll('button')]
        .find((b) => /Show everything on this invoice/.test(b.getAttribute('title') || ''))
      click(chev)
      await sleep(350)
    }
    await openPanel('BM-1')
    const covered = bodyText()
    say('W9: a vendor covered by another invoice reads as on file ->',
      /on file/.test(covered) && /filed on another invoice/.test(covered))
    say('W9: and is NOT reported missing ->', !/none on file for this vendor/.test(covered))
    await openPanel('BM-1')   // close it again

    await openPanel('CO-1')
    say('W9: a vendor with nothing on file is reported missing ->',
      /none on file for this vendor/.test(bodyText()))
    await openPanel('CO-1')

    say('QUEUE: done')

    // The race tail below drives the Salmon invoice, which this fixture does
    // not contain — running it here would report the send flow as broken
    // because there is nothing to send.
    console.error = origError
    say('rendered bytes:', document.getElementById('root').innerHTML.length)
    if (errors.length) {
      say('--- errors ---')
      for (const e of [...new Set(errors)].slice(0, 10)) say(e)
    } else say('no errors captured')
    globalThis.__DONE__ = true
    return
  }

  // ── The detail panel, the guarded edit, and undo / redo ─────────────────
  //
  // None of this is reachable by `npm run smoke`: the panel is behind a click,
  // its fields are behind a fetch, and undo is a second write whose whole
  // behaviour is what the FIRST write recorded. smoke renders the loading
  // branch and reports ok for a page that drew none of it.
  if (SCENARIO === 'detail') {
    const chev = all('button').find((b) => /Show everything on this invoice/.test(b.getAttribute('title') || ''))
    say('SETUP: the row offers a detail disclosure ->', !!chev)

    // Bank numbers must not be on screen before anybody asks for them. Asserted
    // BEFORE opening, so "not visible" cannot be true merely because the panel
    // is shut.
    click(chev); await sleep(300)
    const opened = bodyText()
    say('PANEL: it opens ->', /What the vendor submitted/.test(opened))
    say('PANEL: ledger detail is there ->', /Ledger detail/.test(opened))
    say('PANEL: vendor address renders ->', /3 Wharf Road, London E1/.test(opened))
    say('PANEL: CC emails render ->', /ap@salmonstudios\.net/.test(opened))
    say('PANEL: the socials render ->', /@salmonstudios/.test(opened))
    say('PANEL: the W-9 last 4 renders masked ->', /••4417/.test(opened))
    say('PANEL: the account shows LAST 4 ONLY ->', /••••6012/.test(opened))
    say('PANEL: no full account number is on screen ->', !/1234566012/.test(opened))
    say('PANEL: the bank address renders ->', /1 Lead Plaza, Kansas City MO/.test(opened))

    // An edit, and what it recorded.
    const notes = all('input').find((i) => {
      const lbl = i.closest('div') && i.closest('div').textContent
      return lbl && /^Notes/.test(lbl.trim())
    })
    say('EDIT: the notes field is editable ->', !!notes)
    setValue(notes, 'chased twice')
    blur(notes)
    await sleep(400)
    const wrote = calls.put.filter((c) => c.body && 'notes' in c.body)
    say('EDIT: it PUT the new value ->', wrote.length === 1 && wrote[0].body.notes === 'chased twice')
    say('EDIT: it carried an expectation ->',
      !!(wrote[0] && wrote[0].body.expect && wrote[0].body.expect.field === 'notes'))

    // Undo / redo.
    const undoBtn = all('button').find((b) => /^Undo$/.test((b.textContent || '').trim()))
    say('UNDO: a stack control appeared ->', !!undoBtn)
    click(undoBtn); await sleep(400)
    const undone = calls.put.filter((c) => c.body && 'notes' in c.body)
    say('UNDO: it wrote the OLD value back ->',
      undone.length === 2 && (undone[1].body.notes ?? '') === '')
    say('UNDO: it expected the value it had set ->',
      !!(undone[1] && undone[1].body.expect && undone[1].body.expect.value === 'chased twice'))

    const redoBtn = all('button').find((b) => /^Redo$/.test((b.textContent || '').trim()))
    say('REDO: a redo control appeared ->', !!redoBtn)
    click(redoBtn); await sleep(400)
    const redone = calls.put.filter((c) => c.body && 'notes' in c.body)
    say('REDO: it wrote the new value again ->',
      redone.length === 3 && redone[2].body.notes === 'chased twice')

    // A conflicting undo must REFUSE. Move the row underneath, then undo.
    state.row.notes = 'somebody else got here first'
    click(all('button').find((b) => /^Undo$/.test((b.textContent || '').trim())))
    await sleep(400)
    const after = bodyText()
    say('CONFLICT: the undo was refused ->', /Undo refused/.test(after))
    say('CONFLICT: it names what the row now holds ->', /somebody else got here first/.test(after))
    say('CONFLICT: the row was NOT overwritten ->',
      state.row.notes === 'somebody else got here first')
  }

  // ── Editing a due date from the row ─────────────────────────────────────
  if (SCENARIO === 'duedate' || SCENARIO === 'duedate-family') {
    const family = SCENARIO === 'duedate-family'
    // Split children are collapsed under the parent on this page, so the
    // sibling has to be revealed before the harness can ask whether it moved.
    if (family) {
      const expander = all('button').find((b) => /Expand \d+ split/.test(b.getAttribute('title') || ''))
      say('DUE: the invoice shows an expander ->', !!expander)
      if (expander) click(expander)
      await sleep(300)
    }
    const dates = all('input[type="date"]')
    say('DUE: the row carries a date input ->', dates.length > 0, `(${dates.length})`)
    if (family) say('DUE: both rows of the invoice are listed ->', dates.length === 2, `(${dates.length})`)
    const cell = dates.find((i) => i.value === '2026-08-20')
    say('DUE: it shows the stored due date ->', !!cell)
    if (!cell) { globalThis.__DONE__ = true; return }
    const putsBefore = calls.put.length
    // A date input is committed by a change event, not by typing.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(cell, '2026-09-30')
    cell.dispatchEvent(new window.Event('change', { bubbles: true }))
    await sleep(700)
    const put = calls.put.filter((c) => /\/bk\/entries\//.test(c.url)).pop()
    say('DUE: PUT fired ->', calls.put.length > putsBefore && !!put, put?.url)
    say('DUE: it sent only the due date ->',
      !!put && Object.keys(put.body || {}).join() === 'scheduled_payment_date',
      JSON.stringify(put?.body))
    say('DUE: with the new value ->', put?.body?.scheduled_payment_date === '2026-09-30')
    say('DUE: the cell shows it without a refetch ->',
      all('input[type="date"]').some((i) => i.value === '2026-09-30'))
    // The date belongs to the invoice, so the sibling row on this same page has
    // to move with it. The server cascades; the local patch must agree, or the
    // list shows one invoice due on two different days until the next reload.
    if (family) {
      const values = all('input[type="date"]').map((i) => i.value)
      say('DUE: the sibling row moved too ->',
        values.length === 2 && values.every((v) => v === '2026-09-30'), `(${values.join(', ')})`)
    }
    // Undo has to put the OLD date back, not merely close the toast.
    const undo = all('button').find((b) => /^Undo$/i.test((b.textContent || '').trim()))
    say('DUE: an undo is offered ->', !!undo)
    if (undo) click(undo)
    await sleep(800)
    const back = calls.put.filter((c) => /\/bk\/entries\//.test(c.url)).pop()
    say('DUE: undo re-sent the original date ->', back?.body?.scheduled_payment_date === '2026-08-20',
      JSON.stringify(back?.body))
    say('DUE: and the cell went back ->',
      all('input[type="date"]').some((i) => i.value === '2026-08-20'))
    console.error = origError
    if (errors.length) { say('--- errors ---'); for (const e of [...new Set(errors)].slice(0, 8)) say(e) }
    else say('no errors captured')
    globalThis.__DONE__ = true
    return
  }

  // ── Re-splitting a family this page can only half see ───────────────────
  //
  // The dashboard lists unpaid rows plus a fortnight of paid ones, so one slice
  // of a family can be on screen while another is not. A split REPLACES every
  // slice, so a dialog that opened on the visible half and was submitted would
  // delete the invisible one. It has to say so.
  if (SCENARIO === 'partial') {
    const scissors = all('button').find((b) => /Re-split|Split this invoice/.test(b.getAttribute('title') || ''))
    say('PARTIAL: the row offers a split ->', !!scissors)
    if (scissors) click(scissors)
    await sleep(400)
    say('PARTIAL: the dialog opened ->', /Split between artists/.test(bodyText()))
    say('PARTIAL: it still names the whole invoice ->', /\$700\.00/.test(bodyText()))
    say('PARTIAL: it warns that slices are missing ->', /cannot see every slice/i.test(bodyText()))
    say('PARTIAL: it says splitting replaces them all ->', /replaces every slice/i.test(bodyText()))
    // Nothing is prefilled here — the page holds one row of a family it cannot
    // assemble — so the honest reading is $0.00 of $700.00, and the dialog says
    // that rather than implying the visible row is already a slice.
    say('PARTIAL: and quotes both figures ->', /\$0\.00 of \$700\.00 is showing here/.test(bodyText()))
    console.error = origError
    if (errors.length) { say('--- errors ---'); for (const e of [...new Set(errors)].slice(0, 8)) say(e) }
    else say('no errors captured')
    globalThis.__DONE__ = true
    return
  }

  // ── Split between artists, from the Payments dashboard ──────────────────
  if (SCENARIO === 'split') {
    const scissors = all('button').find((b) => /Split this invoice/.test(b.getAttribute('title') || ''))
    say('SPLIT: the row offers a split ->', !!scissors)
    if (!scissors) { globalThis.__DONE__ = true; return }
    click(scissors)
    await sleep(400)
    say('SPLIT: the dialog opened ->', /Split between artists/.test(bodyText()))
    // It must divide what the VENDOR billed, not some other number.
    say('SPLIT: it names the invoice total ->', /\$700\.00/.test(bodyText()))
    const boxes = all('input[type="text"]').filter((i) => /Artist|Song/.test(i.placeholder || ''))
    say('SPLIT: two slices to start ->', boxes.filter((i) => /Artist/.test(i.placeholder)).length === 2)
    const artists = boxes.filter((i) => /Artist/.test(i.placeholder))
    const songs = boxes.filter((i) => /Song/.test(i.placeholder))
    type(artists[0], 'Jerri'); type(songs[0], 'Nightcrawl')
    type(artists[1], 'Kaia');  type(songs[1], 'Loose')
    await sleep(200)
    const evenly = all('button').find((b) => /Split evenly/.test(b.textContent || ''))
    say('SPLIT: "split evenly" offered ->', !!evenly)
    if (evenly) click(evenly)
    await sleep(250)
    const amounts = all('input[type="number"]').map((i) => i.value)
    say('SPLIT: it divided the invoice, not the row ->', amounts.join('+') === '350.00+350.00', `(${amounts.join(', ')})`)
    say('SPLIT: and says the slices balance ->', /Split: \$700\.00/.test(bodyText()))
    const go = all('button').find((b) => (b.textContent || '').trim() === 'Split')
    if (go) click(go)
    await sleep(900)
    const posted = calls.post.filter((c) => /\/split$/.test(c.url)).pop()
    say('SPLIT: POST …/split fired ->', !!posted, posted?.url)
    const bd = posted?.body?.artist_breakdown || []
    say('SPLIT: it sent two slices ->', bd.length === 2, JSON.stringify(bd))
    say('SPLIT: naming both artists and songs ->',
      bd[0]?.artist === 'Jerri' && bd[0]?.song === 'Nightcrawl'
      && bd[1]?.artist === 'Kaia' && bd[1]?.song === 'Loose')
    say('SPLIT: the amounts add up to the invoice ->',
      Math.abs(bd.reduce((s, x) => s + Number(x.amount || 0), 0) - 700) < 0.005)
    say('SPLIT: the dialog closed ->', !/Split between artists/.test(bodyText()))
    console.error = origError
    if (errors.length) { say('--- errors ---'); for (const e of [...new Set(errors)].slice(0, 8)) say(e) }
    else say('no errors captured')
    globalThis.__DONE__ = true
    return
  }

  // ── drop a proof on it ──
  const drop = [...document.querySelectorAll('div')].find((d) => /Drop file/.test(d.textContent || '')
    && !/Drop file/.test([...d.children].map((c) => c.textContent || '').join('')))
  say('UPLOAD: the drop zone is there ->', !!drop)
  if (!drop) { globalThis.__DONE__ = true; return }
  const file = new window.File(['proof'], 'Screenshot.png', { type: 'image/png' })
  const ev = new window.Event('drop', { bubbles: true })
  ev.dataTransfer = { files: [file] }
  ev.preventDefault = () => {}
  drop.dispatchEvent(ev)
  await sleep(600)
  say('UPLOAD: proof posted ->', calls.post.some((c) => /file\/proof$/.test(c.url)))
  say('UPLOAD: the row now offers Send ->', !!btn(/^Send$/))

  // ── send, inside the window the refetch is still in flight ──
  // Just AFTER the page issues its delayed GET, so the response now in flight
  // was computed before the send — the state John's row was in.
  await sleep(UPLOAD_WAIT_MS + 200)
  const send = btn(/^Send$/)
  say('SEND: button still present when the refetch is in flight ->', !!send)
  if (send) click(send)
  await sleep(700)                       // preview modal
  const confirm = btn(/^Send Confirmation$|^Send email$|^Send$/)
  const inModal = buttons().filter((b) => /Send/.test(b.textContent || ''))
  say('SEND: modal opened ->', /Payment Confirmation|Preview/i.test(bodyText()), `(${inModal.length} send-ish buttons)`)
  // The modal's own submit is the LAST Send-labelled button on the page.
  const submit = inModal[inModal.length - 1] || confirm
  if (submit) click(submit)
  await sleep(600)
  const sent = calls.post.filter((c) => /send-confirmation$/.test(c.url))
  say('SEND: POST send-confirmation fired ->', sent.length > 0)
  say('SEND: the server recorded it ->', state.row.confirmation_sent === true)

  // ── let the stale read land ──
  await sleep(GET_LATENCY_MS + 800)
  const stillOffersSend = !!btn(/^Send$/)
  const offersMarkSent = !!btn(/^Mark Sent$/)
  say('AFTER: a stale refetch has landed ->', calls.get.filter((c) => c.url.startsWith('/bk/payments')).length >= 2)
  // Phrased so that "-> false" always means a failure, which is what the runner
  // greps for. "still offers Send -> false" is a pass reading like a failure.
  say('AFTER: the row no longer offers "Send" ->', !stillOffersSend, '(the email went)')
  say('AFTER: the row no longer offers "Mark Sent" ->', !offersMarkSent)
  say('RESULT: the sent invoice reads as sent ->', !stillOffersSend && !offersMarkSent)

  console.error = origError
  say('rendered bytes:', document.getElementById('root').innerHTML.length)
  if (errors.length) {
    say('--- errors ---')
    for (const e of [...new Set(errors)].slice(0, 10)) say(e)
  } else say('no errors captured')
  globalThis.__DONE__ = true
})()
