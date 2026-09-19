// Do the artist budget cards actually render, and does the merge hold?
//
// `npm run smoke` cannot answer either. It renders under `renderToString`, where
// effects never fire — so the page only ever renders its LOADING branch and
// reports "ok" for a grid that drew nothing. Every number on this page is behind
// a fetch, which means every number is in the branch smoke does not reach.
//
// What is actually at risk here is the MERGE. The page reads two endpoints that
// overlap — `/spend-plans/by-artist` for the plan, `/artist-budgets` for ledger
// spend — and folds them on `artist_key`. Three things can go wrong and none of
// them throws:
//
//   an artist in BOTH renders TWICE            (merge keyed wrong)
//   an artist with spend and no plan VANISHES  (built from the plan list only)
//   an artist with a plan and no spend VANISHES(built from the ledger list only)
//
// The last two are the specific regression this page was warned about: the table
// it replaced deliberately listed 91 artists who had never had a budget, and
// dropping them would turn "what are we spending per artist" into "who is on the
// spreadsheet".
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import ArtistBudgets from '../src/pages/ArtistBudgets'
import { calls } from './artistbudgets-api-stub.js'
import { ThemeProvider } from '../src/context/ThemeContext'

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
const assert = (label, cond) => say(`  ${label} -> ${!!cond}`)

const textOf = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '')
const findByText = (root, re, sel = '*') =>
  [...root.querySelectorAll(sel)].filter((n) => re.test(textOf(n)))
const click = (el) => el && el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))

function Landed() {
  const loc = useLocation()
  return <div data-landed={loc.pathname + loc.search}>landed</div>
}

async function main() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  root.render(
    <Catch>
      <ThemeProvider>
        <MemoryRouter initialEntries={['/artist-budgets']}>
          <Routes>
            <Route path="/artist-budgets" element={<ArtistBudgets />} />
            {/* Where "New budget" lands. Prints the URL so the harness can read it. */}
            <Route path="/artist-budgets/:artistKey" element={<Landed />} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    </Catch>
  )
  await sleep(600)

  const body = () => textOf(host)

  say('\nRENDER')
  assert('the page rendered something at all', host.innerHTML.length > 2000)
  assert('no error was thrown', errors.length === 0)
  if (errors.length) for (const e of errors.slice(0, 4)) say('     ' + e)

  say('\nTHE MERGE')
  const cardHeadings = [...host.querySelectorAll('a')]
    .filter((a) => (a.getAttribute('href') || '').startsWith('/artist-budgets/'))
  const names = cardHeadings.map(textOf)
  assert('Darci renders EXACTLY ONCE (in both endpoints)',
    names.filter((n) => n === 'Darci').length === 1)
  assert('Pluko is listed (a plan, no ledger spend)', names.includes('Pluko'))
  assert('Oxis is listed (ledger spend, never on the sheet)', names.includes('Oxis'))
  assert('three cards, not four', names.length === 3)

  say('\nTHE HEADER COUNTS THE CARDS IT SITS OVER')
  // It used to print /by-artist's artist count (341 live) above a grid of 403,
  // because the ledger-only artists are merged in on the client.
  assert('the header says 3 artists, which is what is on screen',
    /\b3\b artists/.test(body()) || /3 artists/.test(body()))
  assert('it discloses how many have no plan', /1 with ledger spend and nothing on the sheet/.test(body()))

  say('\nPAID MEANS ONE THING')
  // Oxis has ledger spend and no campaign. Its figure must NOT appear under
  // "Paid", which on every other card means paid on the planned campaigns.
  const oxisCard = [...host.querySelectorAll('div')]
    .filter((n) => /^Oxis/.test(textOf(n)) && /204,150|204,149/.test(textOf(n)))
    .pop()
  assert('the ledger-only card renders', !!oxisCard)
  assert('it labels the figure "Ledger spend"', /Ledger spend/.test(textOf(oxisCard)))
  assert('it does NOT label it "Paid"', !/\bPaid\b/.test(textOf(oxisCard)))
  assert('it says no budget has been typed and points at the sheet',
    /no budget typed yet/.test(textOf(oxisCard)))
  // The render branch above is only half of it: the DATA must keep ledger_paid
  // campaign-scoped too, or the header total and the "most paid" sort silently
  // fold in whole-artist spend. Darci is the only campaign-linked paid figure
  // (48,228.12); Oxis's 204,149.77 must NOT be in this total.
  assert('the header total is campaign-linked paid only', /\$48,228 paid on those campaigns/.test(body()))
  assert('it does NOT include whole-artist ledger spend', !/\$252,378|\$252,377/.test(body()))

  say('\nTHE CARD')
  assert('planned is shown', /\$77,388|\$77,388\.12|\$77,388/.test(body()) || /77,388/.test(body()))
  assert('still owed is shown', /14,000/.test(body()))
  assert('paid is shown', /48,228/.test(body()))
  assert('the % of plan paid is shown', /62% of the plan paid/.test(body()))
  assert('a campaign row is inside the card', /Red Eye/.test(body()))
  assert('an owed campaign says so', /7,500\.00 owed/.test(body()))
  assert('a fully paid campaign reads paid', /Let Em Watch|paid/.test(body()))

  say('\nTHE EXPANDER')
  // Four campaigns show; the fifth is behind the toggle. If the slice broke, the
  // fifth would already be on screen and this would pass vacuously — so assert
  // it is ABSENT first.
  assert('the 5th campaign is hidden at rest', !/Let Em Watch/.test(body()))
  const more = findByText(host, /^1 more$/, 'button')[0]
  assert('a "1 more" toggle exists', !!more)
  click(more)
  await sleep(120)
  assert('the 5th campaign appears after expanding', /Let Em Watch/.test(body()))

  say('\nTHE UNLINKED BANNER')
  assert('the unlinked count is stated', /359/.test(body()))
  assert('the unlinked money is stated', /1,588,922|1,588,9/.test(body()))

  say('\nTHE QUEUE TAB')
  const queueTab = findByText(host, /^Unlinked \(359\)$/, 'button')[0]
  assert('the queue tab is labelled with the count', !!queueTab)
  click(queueTab)
  await sleep(400)
  assert('a queued block renders', /Erin Kirby - Bad Luck/.test(body()))
  assert('its suggestion renders', /Erin Kirby — Bad Luck \(2021\)/.test(body()))
  const linkBtn = findByText(host, /Erin Kirby — Bad Luck \(2021\)/, 'button')[0]
  assert('the suggestion is a button you can click', !!linkBtn)
  click(linkBtn)
  await sleep(300)
  const posted = calls.post.find((c) => /\/spend-plans\/701\/link$/.test(c.url))
  assert('clicking it POSTs the link with a release_id',
    !!posted && posted.body && posted.body.release_id === 55)

  say('\nIMPORT TAB')
  const importTab = findByText(host, /^Import sheet$/, 'button')[0]
  assert('the import tab exists on THIS page (not under Import)', !!importTab)
  click(importTab)
  await sleep(200)
  assert('the drop zone renders', /Drop the expense sheet/.test(body()))
  assert('it says the ledger is never written',
    /nothing is ever written to the ledger/i.test(body()))

  say('\nno late errors -> ' + (errors.length === 0))
  if (errors.length) for (const e of errors.slice(0, 6)) say('     ' + e)
    say('\nNEW BUDGET')
  // A label with no sheet had no way onto a sheet. The button asks WHO and
  // opens their sheet; the roster comes from /bk/artist-names, the key from
  // artistBucket, and the spelling rides along so a fresh sheet is not titled
  // by its key.
  const newBtn = host.querySelector('[data-action="new-budget"]')
  assert('the header has a New budget button', !!newBtn)
  click(newBtn)
  await sleep(100)
  const modal = host.querySelector('[data-modal="new-budget"]')
  assert('it opens the picker', !!modal)
  assert('it says typing in a cell is what saves', /type a budget in any cell/i.test(textOf(modal)))
  assert('the roster was read', calls.get.some((u) => u.startsWith('/bk/artist-names')))
  // ArtistSelect renders a trigger button; the menu it opens is PORTALLED to
  // document.body (so it can escape overflow clipping), so its rows are found
  // there, not inside the modal.
  click(modal.querySelector('button'))
  await sleep(150)
  const row = findByText(document.body, /^Rosa Vale$/, 'button')[0]
  assert('the roster name is offered', !!row)
  click(row)
  await sleep(100)
  const openBtn = findByText(modal, /^Open sheet$/, 'button')[0]
  assert('Open sheet is enabled once a real artist is picked', !!openBtn && !openBtn.disabled)
  click(openBtn)
  await sleep(200)
  const landed = host.querySelector('[data-landed]')
  assert('it navigates to that artist\'s sheet by KEY, carrying the spelling',
    !!landed && landed.getAttribute('data-landed') === '/artist-budgets/rosavale?name=Rosa%20Vale')
say('\nDONE')
}

main().catch((e) => { console.log('HARNESS THREW: ' + e.message); console.log('DONE') })
