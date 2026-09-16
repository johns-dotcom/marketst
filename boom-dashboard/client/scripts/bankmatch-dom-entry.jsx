// Mount Bank Matching in a real DOM, against a real server, and press the new
// button for real.
//
// `npm run smoke` renders this page in its LOADING state — effects never fire
// under renderToString — so it can say "ok, 686 bytes" about a page whose table
// never drew a row. The recoupable control lives on a row that only exists once
// data arrives, so a green smoke run says nothing about it at all.
//
// Two scenarios, both end-to-end through scripts/bankmatch-api-stub.js:
//
//   table  — an OPEN debit: press "No", then pick a category (which IS the
//            booking on that row) and assert the POST body carried
//            recoupable:false. This is the path 82% of bank rows take.
//   deck   — open the review deck on the same row, press R twice (unanswered →
//            yes → no) and accept, asserting the same thing about the card.
//
// The fixture rows are created and removed by the caller
// (scratchpad/dom-bankmatch.sh), so this file only drives the UI.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import BkBankMatching from '../src/pages/BkBankMatching'
import { calls } from './bankmatch-api-stub.js'
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
  <MemoryRouter initialEntries={['/bk/bank-matching']}>
    <ThemeProvider><ToastProvider><FxRatesProvider><BoomRepsProvider><CategoriesProvider>
      <Catch><BkBankMatching /></Catch>
    </CategoriesProvider></BoomRepsProvider></FxRatesProvider></ToastProvider></ThemeProvider>
  </MemoryRouter>
)

const PAYEE = process.env.FIXTURE_PAYEE || 'DOMCHECK'
const SCENARIO = process.env.SCENARIO || 'table'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
const buttons = () => [...document.querySelectorAll('button')]
// The fixture's own row, found by the payee it was created with — the dev
// database has other transactions in it and asserting against "the first row"
// would be asserting about whichever one sorted highest.
const fixtureRow = () => [...document.querySelectorAll('tr')]
  .find((tr) => (tr.textContent || '').toUpperCase().includes(PAYEE))
// React tracks the DOM node's value, so a <select> has to be set through the
// prototype descriptor or the synthetic onChange is deduped away.
const setSelect = (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
  setter.call(el, value)
  el.dispatchEvent(new window.Event('change', { bubbles: true }))
}
const key = (k) => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true }))

const say = (...a) => console.log(...a)

;(async () => {
  await sleep(2500) // the page fires ~8 requests on mount
  const row = fixtureRow()
  say('ROW: fixture row on screen ->', !!row)
  if (!row) {
    say('BODY has payee text ->', (document.body.textContent || '').toUpperCase().includes(PAYEE))
    say('rows on screen ->', document.querySelectorAll('tr').length)
    say('api.get calls ->', calls.get.map((c) => c.url).join(' , '))
    say('first 400 chars of text ->', (document.body.textContent || '').slice(0, 400))
  }

  if (SCENARIO === 'table' && row) {
    const label = (row.textContent || '').includes('Recoupable?')
    say('TABLE: the row asks "Recoupable?" ->', label)
    const yes = [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Yes')
    const no = [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'No')
    say('TABLE: Yes/No buttons present ->', !!yes && !!no)
    if (no) {
      click(no)
      await sleep(150)
      // Pressed = ink-filled. If the class never changes, the answer is not
      // being held anywhere and the click is decoration.
      const nowNo = [...fixtureRow().querySelectorAll('button')].find((b) => b.textContent.trim() === 'No')
      say('TABLE: "No" shows as chosen ->', /bg-ink/.test(nowNo?.className || ''))
    }
    // The category picker is PickerMenu, not a <select>: a trigger button that
    // opens a list of option buttons. Picking one IS the booking.
    const trigger = [...fixtureRow().querySelectorAll('button')]
      .find((b) => /Categorize|book as/i.test(b.textContent || ''))
    say('TABLE: category picker found ->', !!trigger)
    if (trigger) {
      click(trigger)
      await sleep(300)
      const opt = [...document.querySelectorAll('button')]
        .find((b) => (b.textContent || '').trim() === 'Bank Fees')
      say('TABLE: an option to pick ->', !!opt)
      const postsBefore = calls.post.length
      if (opt) click(opt)
      await sleep(2500)
      const booked = calls.post.filter((c) => /create-entry/.test(c.url)).pop()
      say('TABLE: POST create-entry fired ->', calls.post.length > postsBefore && !!booked)
      say('TABLE: body ->', JSON.stringify(booked?.body || null))
      say('TABLE: body carries recoupable:false ->', booked?.body?.recoupable === false)
    }
  }

  if (SCENARIO === 'form' && row) {
    // The long way round: the row's ⋯ menu opens a form where payee, category,
    // artist and now the recoupable answer are all chosen before booking.
    const dots = [...row.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '⋯')
    say('FORM: row menu button found ->', !!dots)
    if (dots) {
      click(dots); await sleep(300)
      const open = [...document.querySelectorAll('button')].find((b) => /Book it myself/i.test(b.textContent || ''))
      say('FORM: "Book it myself" found ->', !!open)
      if (open) {
        click(open); await sleep(400)
        const formRow = [...document.querySelectorAll('tr')]
          .find((tr) => /Recoupable\?/.test(tr.textContent || '') && /Book \$/.test(tr.textContent || ''))
        say('FORM: the form asks "Recoupable?" ->', !!formRow)
        const yes = formRow && [...formRow.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Yes')
        say('FORM: Yes button present ->', !!yes)
        if (yes) click(yes)
        await sleep(200)
        const submit = [...document.querySelectorAll('button')].find((b) => /^Book \$/.test((b.textContent || '').trim()))
        say('FORM: submit found ->', !!submit)
        const postsBefore = calls.post.length
        if (submit) click(submit)
        await sleep(2500)
        const booked = calls.post.filter((c) => /create-entry|no-invoice/.test(c.url)).pop()
        say('FORM: POST fired ->', calls.post.length > postsBefore && !!booked, booked?.url)
        say('FORM: body ->', JSON.stringify(booked?.body || null))
        say('FORM: body carries recoupable:true ->', booked?.body?.recoupable === true)
      }
    }
  }

  if (SCENARIO === 'keep' && row) {
    // An already-booked, never-answered row: the card keeps the category and the
    // answer cannot ride along on a booking, so it has to go through
    // /bk/recoup-review. That is the path applyDeckRecoup exists for, and a gate
    // in it (only a row this app booked) could silently no-op.
    // ANCHORED at the start of the label, not a bare /Review/i.
    //
    // The deck opener for this scenario is the bulk bar's "Re-review N" — the
    // fixture is a booked-with-no-invoice row, so it sits inside the default
    // filter. A loose /Review/i also matches the "For review" TAB, which is
    // earlier in the DOM and merely sets a filter: the harness then clicked a
    // tab, no deck opened, and all six assertions below failed while the page
    // was working perfectly. A selector that matches a label somebody is free
    // to rename is a test that fails for the wrong reason.
    const open = buttons().find((b) => /^(re-)?review\b/i.test((b.textContent || '').trim()))
    if (!open) { say('KEEP: no deck opener'); }
    else {
      click(open)
      await sleep(1500)
      const card = () => document.querySelector('.shadow-2xl')
      const cardText = () => (card()?.textContent || '')
      let hops = 0
      while (hops < 20 && !cardText().toUpperCase().includes(PAYEE)) {
        key('ArrowLeft'); await sleep(350); hops += 1
      }
      say('KEEP: reached the fixture card ->', cardText().toUpperCase().includes(PAYEE), `after ${hops} skips`)
      say('KEEP: the card is a keep/rebook one ->', /swipe right to keep|Booked as/i.test(cardText()))
      say('KEEP: card asks "Recoupable?" ->', cardText().includes('Recoupable?'))
      key('r'); await sleep(200)
      say('KEEP: after one R, "bills back to the artist" ->', cardText().includes('bills back to the artist'))
      const postsBefore = calls.post.length
      key('ArrowRight')
      await sleep(2500)
      const answered = calls.post.filter((c) => /recoup-review/.test(c.url)).pop()
      say('KEEP: POST /bk/recoup-review fired ->', calls.post.length > postsBefore && !!answered)
      say('KEEP: body ->', JSON.stringify(answered?.body || null))
      say('KEEP: body says recoupable:true ->', answered?.body?.recoupable === true)
    }
  }

  if (SCENARIO === 'deck' && row) {
    const open = buttons().find((b) => /Review|Start review|Deck/i.test(b.textContent || ''))
    say('DECK: opener found ->', !!open, open?.textContent?.trim().slice(0, 40))
    if (open) {
      click(open)
      await sleep(1500)
      // Assert against the CARD, never document.body: the table is still
      // rendered behind the overlay and its own recoupable control would answer
      // every one of these questions for a row nobody is looking at.
      const card = () => document.querySelector('.shadow-2xl')
      const cardText = () => (card()?.textContent || '')
      // Skip to the fixture's own card. The deck orders by how likely a match
      // is, so the row this run created is not the one it opens on.
      let hops = 0
      while (hops < 20 && !cardText().toUpperCase().includes(PAYEE)) {
        key('ArrowLeft'); await sleep(350); hops += 1
      }
      say('DECK: reached the fixture card ->', cardText().toUpperCase().includes(PAYEE), `after ${hops} skips`)
      say('DECK: card asks "Recoupable?" ->', cardText().includes('Recoupable?'))
      say('DECK: legend mentions the R key ->',
        (document.body.textContent || '').includes('R recoupable yes/no'))
      key('r'); await sleep(200)
      say('DECK: after one R, "bills back to the artist" ->',
        cardText().includes('bills back to the artist'))
      key('r'); await sleep(200)
      say('DECK: after two R, "the label absorbs it" ->',
        cardText().includes('the label absorbs it'))
      const postsBefore = calls.post.length
      key('ArrowRight')
      await sleep(2000)
      const booked = calls.post.filter((c) => /create-entry|no-invoice/.test(c.url)).pop()
      say('DECK: accept posted ->', calls.post.length > postsBefore, booked?.url)
      say('DECK: body ->', JSON.stringify(booked?.body || null))
      say('DECK: body carries recoupable:false ->', booked?.body?.recoupable === false)
    }
  }

  console.error = origError
  say('rendered bytes:', document.getElementById('root').innerHTML.length)
  if (errors.length) {
    say('--- errors ---')
    for (const e of [...new Set(errors)].slice(0, 12)) say(e)
  } else say('no errors captured')
  globalThis.__DONE__ = true
})()
