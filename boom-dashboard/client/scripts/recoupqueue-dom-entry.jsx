// Does the recoupments upload queue render, and does the partition hold?
//
// `npm run smoke` cannot answer either. It renders under `renderToString`,
// where effects never fire — so Recoupments only ever draws its loading
// skeleton and reports "ok" for a queue that drew nothing. Every figure and
// every partition on this page is behind `/bk/entries`, which means all of it
// is in the branch smoke does not reach.
//
// What is at risk is the PARTITION and the RANK. The page's whole claim is that
// an agent can read the first screen and know what to upload. Four things can
// go wrong and none of them throws:
//
//   an artist with provable money lands in a FOLDED section   → work goes invisible
//   an artist with nothing uploadable lands in the QUEUE      → the ranking is noise again
//   an unpaid-only artist reads as actionable                 → you cannot upload it at all
//   the per-row Upload button posts the wrong ids             → it claims the wrong money
//
// That last one is the write path, so it is asserted against what actually
// reaches `POST /bk/entries/ufr-bulk`, not against the button existing.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Recoupments from '../src/pages/Recoupments'
import api, { calls } from './recoupqueue-api-stub.js'
import { ThemeProvider } from '../src/context/ThemeContext'
import { FxRatesProvider } from '../src/context/FxRatesContext'
import { CategoriesProvider } from '../src/context/CategoriesContext'
import { ToastProvider } from '../src/context/ToastContext'

const errors = []
window.addEventListener('error', (e) => errors.push('window.error: ' + e.message))
console.error = (...a) => { errors.push('console.error: ' + a.map(String).join(' ').slice(0, 300)) }
// The Upload buttons go through window.confirm — auto-accept so the write path
// is exercised rather than silently skipped.
window.confirm = () => true
window.alert = () => {}

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
const click = (el) => el && el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))

async function main() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  createRoot(host).render(
    <Catch>
      <ThemeProvider>
        <ToastProvider>
          <FxRatesProvider>
            <CategoriesProvider>
              <MemoryRouter initialEntries={['/recoupments']}>
                <Recoupments />
              </MemoryRouter>
            </CategoriesProvider>
          </FxRatesProvider>
        </ToastProvider>
      </ThemeProvider>
    </Catch>
  )
  await sleep(900)

  const body = () => textOf(host)
  // A section's rows are the artist links under the card that follows its
  // heading. Read them positionally off the rendered order rather than by
  // class, so the assertion describes what an agent SEES.
  // /recoupments/planning, /2025 and /audit are sibling ROUTES, not artists,
  // and they match the artist-route shape exactly — so they are named and
  // excluded rather than pattern-dodged.
  const NOT_ARTISTS = new Set(['planning', '2025', 'audit'])
  const artistLinks = () => [...host.querySelectorAll('a')]
    .filter((a) => /^\/recoupments\/[^/]+$/.test(a.getAttribute('href') || ''))
    .map((a) => decodeURIComponent(a.getAttribute('href').split('/').pop()))
    .filter((n) => !NOT_ARTISTS.has(n))

  say('\nRENDER')
  assert('the page rendered something at all', host.innerHTML.length > 3000)
  assert('no error was thrown', errors.length === 0)
  if (errors.length) for (const e of errors.slice(0, 6)) say('     ' + e)

  say('\nTHE FETCH BOUNDARY STILL HOLDS')
  // Both exclusions live at the fetch boundary precisely so the tiles, the
  // grouping memo and the queue partitions all inherit them.
  assert('an UNREVIEWED bank-born row never reaches the page', !/Ghost Bank Row/.test(body()))
  assert('a row somebody marked NOT recoupable gets no queue row',
    !artistLinks().includes('Not Recoupable Co'))
  // It IS still in the artist filter dropdown, which is deliberate: the
  // dropdown is built from `entries`, so switching the Recoupable filter to
  // "No" can still find them and promote them back.
  assert('...but it stays reachable from the artist filter',
    [...host.querySelectorAll('option')].some((o) => textOf(o) === 'Not Recoupable Co'))
  assert('neither inflates a figure', !/999,999|88,888/.test(body()))

  say('\nTHE SUMMARY LINE LEADS WITH WHAT CAN BE UPLOADED')
  // 276,200 + 40,949 + 60,976 = 378,125 provable across 3 artists.
  assert('it states the provable total', /\$378,125/.test(body()))
  assert('it says "ready to upload"', /ready to upload/.test(body()))
  assert('it counts the items and the artists', /4 items across 3 artists/.test(body()))
  assert('it offers to upload all of them', /Upload all 4/.test(body()))
  // The four bands are one partition of the pending pile, so each is stated
  // separately and none is folded into a single "pending" figure.
  assert('awaiting-the-bank is stated separately', /\$79,820 awaiting the bank/.test(body()))
  assert('unpaid is stated separately', /\$24,380 unpaid/.test(body()))
  assert('uploaded-with-no-bank-line is called out', /2 uploaded with no bank line/.test(body()))
  // The five tiles the line replaced described cash flow, not the job.
  assert('the Paid / Unpaid tiles are gone from the index', !/Unpaid · not yet recoupable/.test(body()))
  assert('the "Pending Upload" tile is gone', !/Pending Upload/.test(body()))

  say('\nTHE PARTITION: ONLY UPLOADABLE ARTISTS ARE IN THE QUEUE')
  const queueHead = [...host.querySelectorAll('h3')].find((h) => /Ready to upload/.test(textOf(h)))
  assert('the queue is headed "Ready to upload"', !!queueHead)
  assert('it counts its own artists and dollars', /3 artists · \$378,125/.test(body()))
  const names = artistLinks()
  // Rank: provable dollars, descending. This is the whole point — the top of
  // the list has to be the money.
  assert('Feel trip ranks first (largest provable)', names[0] === 'Feel trip')
  assert('Jerri second, Oxis third', names[1] === 'Jerri' && names[2] === 'Oxis')
  assert('the queue holds exactly the 3 uploadable artists', names.length === 3)
  assert('the three folded artists are NOT in the queue',
    !names.slice(0, 3).includes('Shonci') && !names.slice(0, 3).includes('Zeke Bleu'))

  say('\nTHE FOLDED SECTIONS NAME WHY THEY ARE FOLDED')
  assert('"Nothing provable yet" exists', /Nothing provable yet/.test(body()))
  assert('it says what it is waiting on', /waiting on the statement that proves it/.test(body()))
  assert('"Nothing to do" exists', /Nothing to do/.test(body()))
  assert('it says unpaid cannot be recouped yet', /it cannot be recouped yet/.test(body()))
  assert('the error band is named separately', /Uploaded with no bank line/.test(body()))
  // Folded means folded: an agent should not have to scroll past 3 sections of
  // rows they cannot act on to reach the ones they can.
  assert('Shonci is not on screen until its section is opened', !names.includes('Shonci'))
  assert('Zeke Bleu is not on screen either', !names.includes('Zeke Bleu'))
  assert('nor is the fully-uploaded artist', !names.includes('Laszewo'))
  assert('and the flagged artist is listed once, not twice',
    names.filter((n) => n === 'Jerri').length === 1)

  const waitingBtn = [...host.querySelectorAll('button')]
    .find((b) => /Nothing provable yet/.test(textOf(b)))
  click(waitingBtn)
  await sleep(200)
  assert('opening it reveals Shonci', artistLinks().includes('Shonci'))
  assert('and still not Zeke Bleu (a different section)', !artistLinks().includes('Zeke Bleu'))

  say('\nTHE ROW SAYS WHAT TO UPLOAD, HOW MANY, AND FOR HOW MUCH')
  const rowFor = (name) => {
    const link = [...host.querySelectorAll('a')]
      .find((a) => a.getAttribute('href') === '/recoupments/' + encodeURIComponent(name))
    return link ? link.parentElement : null
  }
  const oxis = rowFor('Oxis')
  assert('the Oxis row renders', !!oxis)
  assert('it leads with the provable dollars', /\$40,949/.test(textOf(oxis)))
  assert('it shows the awaiting-bank dollars too', /\$48,463/.test(textOf(oxis)))
  // The unverified row is not uploaded, so it belongs to the paid-with-no-line
  // band the summary line calls out, not to the uploaded-with-no-line flag.
  assert('the page states the pending unverified money', /\$2,500 paid with no bank line/.test(body()))
  // Oxis has 6 PAID rows (2 provable, 2 awaiting, 1 unverified, 1 claimed) and
  // one unpaid; the unpaid one must not be in the denominator, or 100% is
  // permanently out of reach.
  const cellTexts = (r) => [...r.querySelectorAll('span, button')].map(textOf)
  assert('it shows uploaded progress over PAID items only (1 of 6)',
    cellTexts(oxis).includes('1/6'))
  assert('it does NOT count the unpaid invoice in the denominator',
    !cellTexts(oxis).includes('1/7'))
  assert('it offers a one-click upload of exactly its provable items',
    cellTexts(oxis).includes('Upload 2'))
  const jerri = rowFor('Jerri')
  assert('the flagged row shows its no-bank-line count', cellTexts(jerri).includes('2'))

  say('\nTHE WRITE PATH')
  // A button that renders is not a button that writes. Assert on what reaches
  // the endpoint: the ids must be exactly the artist's provable, unclaimed rows
  // — not their whole roster, and not the page's.
  const before = calls.post.length
  const uploadBtn = [...oxis.querySelectorAll('button')].find((b) => /^Upload \d+$/.test(textOf(b)))
  click(uploadBtn)
  await sleep(400)
  const posted = calls.post[before]
  assert('it posted to /bk/entries/ufr-bulk', posted && posted.url === '/bk/entries/ufr-bulk')
  assert('it asked for ufr: true', posted && posted.body.ufr === true)
  assert('it sent exactly Oxis\'s TWO provable rows',
    posted && posted.body.ids.length === 2)
  assert('the ids are the provable rows, not the awaiting / unverified / claimed ones',
    posted && [3, 4].every((id) => posted.body.ids.includes(id)))

  say('\nTHE SUMMARY BUTTON CLAIMS THE WHOLE PAGE, NOT ONE ARTIST')
  const before2 = calls.post.length
  click([...host.querySelectorAll('button')].find((b) => /^Upload all 4$/.test(textOf(b))))
  await sleep(400)
  const posted2 = calls.post[before2]
  assert('it posted 4 ids', posted2 && posted2.body.ids.length === 4)
  assert('they are the four provable rows across the three artists',
    posted2 && [1, 3, 4, 10].every((id) => posted2.body.ids.includes(id)))

  // ── The artist subpage: one grouping level ────────────────────────────
  // This is the phase the nesting change exists for, and a green index run says
  // nothing about it. Oxis is fixtured so the OLD four-level tree rendered
  // THIRTEEN headers around six pending rows (see the stub's comment for the
  // arithmetic); one grouping level means TWO.
  say('\nTHE ARTIST SUBPAGE')
  const host2 = document.createElement('div')
  document.body.appendChild(host2)
  createRoot(host2).render(
    <Catch>
      <ThemeProvider><ToastProvider><FxRatesProvider><CategoriesProvider>
        <MemoryRouter initialEntries={['/recoupments/Oxis']}>
          <Routes><Route path="/recoupments/:artistName" element={<Recoupments />} /></Routes>
        </MemoryRouter>
      </CategoriesProvider></FxRatesProvider></ToastProvider></ThemeProvider>
    </Catch>
  )
  await sleep(900)
  const d = () => textOf(host2)
  // A song group is the only container left between the filter bar and a row.
  const groupCards = () => [...host2.querySelectorAll('[class*="group/grp"]')]
  const rows = () => [...host2.querySelectorAll('[class*="border-l-emerald-500"], [class*="border-l-sky-400"], [class*="border-l-rose-500"], [class*="border-l-gray-300"]')]
  assert('the subpage rendered', host2.innerHTML.length > 3000)
  assert('no error was thrown', errors.length === 0)
  if (errors.length) for (const e of errors.slice(0, 6)) say('     ' + e)
  assert('it is scoped to the one artist', /Oxis/.test(d()))
  assert('the index queue is NOT on the subpage', !/Ready to upload/.test(d()))

  say('\n  ONE GROUPING LEVEL')
  assert('six pending rows render', rows().length === 6)
  assert('under exactly TWO song groups, not thirteen headers', groupCards().length === 2)
  assert('both songs are named', /Red Eye/.test(d()) && /Grave Shift/.test(d()))
  // The invariant, stated structurally rather than by hunting for a class: a
  // row's PARENT is the group card. Any surviving category or label bucket
  // would be a <div> in between, and this is the assertion that sees it.
  assert('nothing sits between a group and its rows',
    rows().every((r) => groupCards().includes(r.parentElement)))
  // The label bucket's indent is not used anywhere else in the file, so its
  // absence is also checkable directly. (pl-8 is NOT — the search input uses it.)
  assert('no label sub-bucket header renders',
    host2.querySelectorAll('[class*="pl-10"]').length === 0)
  assert('the four state SECTIONS are gone', !/Unverified — no bank line/.test(d()))
  assert('so is the "Unpaid Invoices" section', !/Unpaid Invoices/.test(d()))

  say('\n  WHAT THE BUCKETS SAID, THE ROW NOW SAYS')
  // Grave Shift holds one Marketing row and one Video row. The category bucket
  // was the only thing that distinguished them; now the chip has to.
  const graveCard = groupCards().find((c) => /Grave Shift/.test(textOf(c)))
  assert('the Grave Shift group renders', !!graveCard)
  assert('its Marketing row says Marketing on itself', /Marketing/.test(textOf(graveCard)))
  assert('its Video row says Video on itself', /Video/.test(textOf(graveCard)))
  // Red Eye's two provable rows share a label, which used to be a header.
  const redCard = groupCards().find((c) => /Red Eye/.test(textOf(c)))
  assert('the shared label rides on the rows, not a header', /Q3 batch/.test(textOf(redCard)))

  say('\n  THE ROW CARRIES THE STATE THE SECTIONS CARRIED')
  assert('two verified rows have an emerald rail',
    host2.querySelectorAll('[class*="border-l-emerald-500"]').length === 2)
  assert('two awaiting rows have a sky rail',
    host2.querySelectorAll('[class*="border-l-sky-400"]').length === 2)
  assert('the one unverified row has a rose rail',
    host2.querySelectorAll('[class*="border-l-rose-500"]').length === 1)
  assert('the one unpaid row has a grey rail',
    host2.querySelectorAll('[class*="border-l-gray-300"]').length === 1)
  // The sections put the discrepancy first. Sorting has to keep doing that.
  const redRows = [...redCard.querySelectorAll('[class*="border-l-"]')]
  assert('inside a song, the unverified row sorts FIRST',
    /border-l-rose-500/.test(redRows[0].className))
  assert('then the provable rows, largest first',
    /\$20,949/.test(textOf(redRows[1])) && /\$20,000/.test(textOf(redRows[2])))

  say('\n  THE BANDS AND THE PERIOD ARE FILTERS NOW')
  const chip = (re) => [...host2.querySelectorAll('button')].find((b) => re.test(textOf(b)))
  assert('a Verified chip states its count', !!chip(/^Verified2$/))
  assert('an Awaiting chip states its count', !!chip(/^Awaiting2$/))
  assert('an Unverified chip states its count', !!chip(/^Unverified1$/))
  assert('an Unpaid chip states its count', !!chip(/^Unpaid1$/))
  assert('the period chips are here', !!chip(/^Pending6$/) && !!chip(/^Uploaded1$/))
  // Oxis has one UFR'd row stamped 2026-08-14, so one monthly chip exists.
  assert('the one statement month gets its own chip', /Aug 2026/.test(d()))

  click(chip(/^Unverified1$/))
  await sleep(200)
  assert('clicking a band narrows to its rows', rows().length === 1)
  assert('and to the one song that holds it', groupCards().length === 1)
  assert('the band chip does not change the counts on the other chips',
    !!chip(/^Verified2$/) && !!chip(/^Awaiting2$/))
  click(chip(/^Unverified1$/))
  await sleep(200)
  assert('clicking it again clears the filter', rows().length === 6)

  // Two branches the default view never reaches. Both change what the row
  // renders — the period swaps the list wholesale, and grouping by category
  // flips WHICH chip the group header makes redundant — so a green run on
  // Pending/by-song says nothing about either.
  click(chip(/^Uploaded1$/))
  await sleep(250)
  assert('switching period shows the uploaded row', rows().length === 1)
  assert('and only the song that holds it', groupCards().length === 1)
  assert('the uploaded row still gets its state rail',
    host2.querySelectorAll('[class*="border-l-emerald-500"]').length === 1)
  click(chip(/^Pending6$/))
  await sleep(250)
  assert('switching back restores the pending list', rows().length === 6)

  const groupSel = host2.querySelector('select')
  groupSel.value = 'category'
  groupSel.dispatchEvent(new window.Event('change', { bubbles: true }))
  await sleep(250)
  assert('grouping by category regroups the same six rows', rows().length === 6)
  assert('into the two categories', groupCards().length === 2)
  assert('and nothing sits between a category group and its rows',
    rows().every((r) => groupCards().includes(r.parentElement)))
  // The axis the header establishes is the one stripped from the row; the OTHER
  // one has to still be there, or regrouping loses the song entirely.
  assert('the rows now carry their SONG instead',
    groupCards().some((c) => /Red Eye/.test(textOf(c))) &&
    groupCards().some((c) => /Grave Shift/.test(textOf(c))))
  groupSel.value = 'song'
  groupSel.dispatchEvent(new window.Event('change', { bubbles: true }))
  await sleep(250)
  assert('and back to song', groupCards().length === 2)

  say('\n  THE TILES NO LONGER RESTATE THE CHIPS')
  assert('the tile grid is still here (index-only removal)', /Recoupable · bank basis/.test(d()))
  assert('Pending Upload is still a tile here', /Pending Upload/.test(d()))
  assert('the Paid and Unpaid tiles are gone', !/Unpaid · not yet recoupable/.test(d()))
  assert('and the per-band note under the bank-basis tile is gone',
    !/awaiting the statement/.test(d()))

  say('\n  HIDE WHEN NOTHING IS USING IT')
  // is_2025_expense is false on every fixture row, as it is on all 1,414 live
  // rows. The grey "2025" button rendered on every one of them.
  assert('no 2025 tag renders on any row',
    rows().every((r) => !/\b2025\b/.test(textOf(r))))
  // ...but the hover-only way IN survives on the group header, or the bucket
  // could never be filled again and the gate would be permanent.
  assert('the group header still offers "Mark 2025"',
    groupCards().some((c) => /Mark 2025/.test(textOf(c))))
  assert('the artist-note card is not an empty card', !/Add note…/.test(d()))
  assert('but the header offers a way to write one',
    [...host2.querySelectorAll('button')].some((b) => textOf(b) === 'Note'))

  say('\n  SELECTION STILL REACHES THE BULK BAR')
  // The checkboxes moved. The group header's select-all used to cover a song
  // inside ONE state section, with two more select-alls below it on buckets
  // that no longer exist; it now covers the whole song across every band, which
  // is strictly more rows than it used to select.
  // .click(), not a dispatched 'change': React attaches its synthetic handler
  // to click for checkboxes, and assigning .checked directly bypasses its value
  // tracker entirely. A dispatched change event leaves onChange unfired, and an
  // assertion on the page text then passes vacuously — which is exactly what
  // happened while writing this.
  redCard.querySelector('input[type="checkbox"]').click()
  await sleep(250)
  // Assert on the BAR's own text. It is the only thing that says "N selected".
  const bar = [...document.querySelectorAll('div')]
    .find((n) => /^\d+ selected/.test(textOf(n)))
  assert('the bulk action bar appears', !!bar)
  assert('the song header selected all three of its rows — every band, not one',
    bar && /^3 selected/.test(textOf(bar)))
  assert('the bar offers the batch actions', bar && /Label/.test(textOf(bar)))

  say('\n  THE DETAIL WRITE PATH')
  const provBtn = [...host2.querySelectorAll('button')]
    .find((b) => /^Upload 2 provable now/.test(textOf(b)))
  assert('the provable-now note offers the upload', !!provBtn)
  const before3 = calls.post.length
  click(provBtn)
  await sleep(400)
  const posted3 = calls.post[before3]
  assert('it posts to the same one writer', posted3 && posted3.url === '/bk/entries/ufr-bulk')
  assert('with this artist\'s provable rows only',
    posted3 && posted3.body.ids.length === 2 && [3, 4].every((id) => posted3.body.ids.includes(id)))

  say('\nDONE')
  globalThis.__DONE__ = true
}

main().catch((e) => { say('HARNESS THREW: ' + e.message); say(e.stack); say('\nDONE'); globalThis.__DONE__ = true })
