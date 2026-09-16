// Mount the Approvals checklist deck in a REAL DOM.
//
// `npm run smoke` renders BkApprovals with renderToString, and this deck is a
// modal that only mounts once a person opens it with items — so the page can be
// green while every line of the deck is unexecuted. That is the same gap that
// let a white My Work ship (see mywork-dom-entry.jsx).
//
// What it asserts, both of them John's asks on 2026-08-27:
//   • socials are EDITABLE and a new one can be added
//   • the Rush button is on the card and hits the payment endpoints
//   • a SPLIT invoice shows as split (John, 2026-08-31: "split invoices don't
//     show as split inside the reviews"). SCENARIO=split drives that one.
//
// And the thing that is easy to get wrong and impossible to see: a social row
// may carry `artist` (which artist of a split this handle belongs to) and
// `amount` (the per-creator carve-out). Editing a handle must not drop them.
import React from 'react'
import { createRoot } from 'react-dom/client'
import ApprovalChecklistDeck from '../src/components/ApprovalChecklistDeck'
import { calls } from './approval-deck-api-stub.js'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '../src/context/ThemeContext'
import { ToastProvider } from '../src/context/ToastContext'
import { FxRatesProvider } from '../src/context/FxRatesContext'
import { CategoriesProvider } from '../src/context/CategoriesContext'

const errors = []
window.addEventListener('error', (e) => errors.push('window.error: ' + e.message))
const origError = console.error
console.error = (...a) => { errors.push('console.error: ' + a.map(String).join(' ').slice(0, 400)) }

class Catch extends React.Component {
  constructor(p) { super(p); this.state = { err: null } }
  static getDerivedStateFromError(err) { return { err } }
  componentDidCatch(err) {
    errors.push('THROWN: ' + (err && err.message))
    errors.push('STACK: ' + String((err && err.stack) || '').split('\n').slice(0, 6).join(' | '))
  }
  render() { return this.state.err ? null : this.props.children }
}

// Shaped on the live row from John's screenshot: Steven Whitaker, inv 0018,
// $2,000, vendor-submitted, three handles. The third carries an artist scope
// so the "do not drop what this card does not show" assertion has something to
// bite on.
const ENTRY = {
  id: 10408,
  payee: 'Steven Whitaker',
  invoice_number: '0018',
  amount: 2000,
  currency: 'USD',
  vendor_submitted: true,
  artist: 'nikko',
  song: '4 music videos / song promos for Market Street',
  category: 'Marketing',
  status: 'pending',
  invoice_filename: null,
  social_handles: [
    { platform: 'Instagram', handle: '@whitaswhit' },
    { platform: 'TikTok', handle: '@whitaswhit' },
    { platform: 'YouTube', handle: '@whitaswhit', artist: 'nikko', amount: 500 },
  ],
  rush_requested: false,
}

// John's screenshot, 2026-08-31: one $1,000 invoice covering two artists at
// $500 each. The confirmations show the PARENT's single artist and the FULL
// amount, so without the split panel the approver is asked to confirm
// "Kaidro / $1,000.00" while Oxis is nowhere on screen.
const SPLIT_ENTRY = {
  ...ENTRY,
  id: 10409,
  payee: 'Alec Robertson',
  invoice_number: '#INV-2026-08-31',
  amount: 1000,
  artist: 'Kaidro',
  song: "just when it's over ($500)",
}
const SPLIT_ROWS = [
  { artist: 'Kaidro', song: "just when it's over ($500)", amount: '500' },
  { artist: 'Oxis', song: 'tilapia', amount: '500' },
]
// A split that does NOT sum to the invoice — the silent error class the panel
// is meant to catch, since the parent quietly keeps the difference.
const SPLIT_ROWS_BAD = [
  { artist: 'Kaidro', song: "just when it's over", amount: '500' },
  { artist: 'Oxis', song: 'tilapia', amount: '300' },
]

// John, 2026-09-15: the Correct artist? field should be a typable dropdown of
// the roster. It was a bare text box — so the way to fix a name was to retype
// it, which is how "manila killa" ends up beside "Manila Killa" as a second
// artist with its own spend. This row is that exact case.
const ARTIST_ENTRY = {
  ...ENTRY,
  id: 10410,
  payee: 'DNZ Media Group, LLC',
  invoice_number: '559',
  amount: 250,
  artist: 'manila killa',
  song: null,
  category: 'Artist Expense - Other',
  social_handles: [],
}

const SCENARIO = process.env.SCENARIO || 'socials'
const isSplit = SCENARIO === 'split' || SCENARIO === 'splitbad'
const isArtist = SCENARIO === 'artist'
const ROWS = SCENARIO === 'splitbad' ? SPLIT_ROWS_BAD : SPLIT_ROWS

const patched = []
const root = createRoot(document.getElementById('root'))
root.render(
  <MemoryRouter initialEntries={['/bk/approvals']}>
    <ThemeProvider>
      <ToastProvider>
        <FxRatesProvider>
          <CategoriesProvider>
            <Catch>
              <ApprovalChecklistDeck
                items={[isArtist ? ARTIST_ENTRY : isSplit ? SPLIT_ENTRY : ENTRY]}
                categories={['Marketing', 'Services']}
                breakdownFor={() => (isSplit ? ROWS : null)}
                onEntryPatched={(id, patch) => patched.push({ id, patch })}
                onApproved={() => {}}
                onClose={() => {}} />
            </Catch>
          </CategoriesProvider>
        </FxRatesProvider>
      </ToastProvider>
    </ThemeProvider>
  </MemoryRouter>
)

const setValue = (el, v) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(el, v)
  el.dispatchEvent(new window.Event('input', { bubbles: true }))
}
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
// React 17+ delegates onBlur to the BUBBLING `focusout`, not to `blur` (which
// does not bubble and never reaches the root listener). Dispatching `blur` here
// made the save look broken when it was the harness that was wrong.
const blur = (el) => el.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }))
const handleInputs = () => [...document.querySelectorAll('input')]
  .filter((i) => i.placeholder === '@handle')
const platformInputs = () => [...document.querySelectorAll('input')]
  .filter((i) => i.placeholder === 'Platform')

if (!isArtist) setTimeout(() => {
  const body = () => document.getElementById('root').innerHTML
  console.log('rendered bytes:', body().length)
  console.log('SOCIALS: handle inputs ->', handleInputs().length, '(3 on file)');
  console.log('SOCIALS: platform inputs ->', platformInputs().length)
  console.log('RUSH: button present ->',
    [...document.querySelectorAll('button')].some((b) => /Rush/.test(b.textContent || '')))

  // ── Edit a handle ────────────────────────────────────────────────────────
  const h = handleInputs()[0]
  if (h) {
    setValue(h, '@whitaswhit_real')
    blur(h)
  }
  setTimeout(() => {
    // Keyed off the entry actually mounted, not a hardcoded id — the split
    // scenarios use a different row, and a filter that matches nothing reports
    // "PUT fired -> false" as though the editor were broken.
    const mountedId = (isSplit ? SPLIT_ENTRY : ENTRY).id
    const put = calls.put.find((c) => new RegExp(`/bk/entries/${mountedId}$`).test(c.url))
    console.log('SOCIALS: PUT fired ->', !!put)
    console.log('SOCIALS: edited handle sent ->',
      JSON.stringify(put?.body?.social_handles?.[0] || null))
    // THE assertion this harness exists for.
    const kept = put?.body?.social_handles?.find((r) => r.platform === 'YouTube')
    console.log('SOCIALS: artist+amount survived the edit ->', JSON.stringify(kept || null))

    // ── Add one ────────────────────────────────────────────────────────────
    const add = [...document.querySelectorAll('button')].find((b) => /\+ Add/.test(b.textContent || ''))
    console.log('SOCIALS: Add button present ->', !!add)
    if (add) click(add)
    setTimeout(() => {
      console.log('SOCIALS: handle inputs after Add ->', handleInputs().length, '(expect 4)')
      const fresh = handleInputs()[3]
      if (fresh) {
        setValue(fresh, '@newhandle')
        blur(fresh)
      }
      setTimeout(() => {
        const last = calls.put[calls.put.length - 1]
        console.log('SOCIALS: added handle reached the server ->',
          !!last?.body?.social_handles?.some((r) => r.handle === '@newhandle'),
          `(${last?.body?.social_handles?.length} rows sent)`)

        // ── Remove one ───────────────────────────────────────────────────
        const xs = [...document.querySelectorAll('button')].filter((b) => (b.textContent || '').trim() === '×')
        console.log('SOCIALS: remove buttons ->', xs.length)
        if (xs.length) click(xs[0])
        setTimeout(() => {
          const afterRm = calls.put[calls.put.length - 1]
          console.log('SOCIALS: remove SAVED the shorter list ->',
            afterRm?.body?.social_handles?.length,
            '(the mouseup-before-click bug would send the same count back)')

          // ── Rush ───────────────────────────────────────────────────────
          window.prompt = () => 'needed friday'
          const rush = [...document.querySelectorAll('button')].find((b) => /Rush/.test(b.textContent || ''))
          if (rush) click(rush)
          setTimeout(() => {
            console.log('RUSH: POST ->', JSON.stringify(calls.post.filter((c) => /rush/.test(c.url))))
            console.log('RUSH: patched upward ->',
              JSON.stringify(patched.filter((p) => 'rush_requested' in (p.patch || {}))))
            click([...document.querySelectorAll('button')].find((b) => /Rush/.test(b.textContent || '')))
            setTimeout(() => {
              console.log('RUSH: DELETE ->', JSON.stringify(calls.del.filter((c) => /rush/.test(c))))
              console.log('APPROVE: still gated ->',
                !![...document.querySelectorAll('button')]
                  .find((b) => /Approve/.test(b.textContent || ''))?.disabled,
                '(rush is a note to AP, not a checklist answer)')
            }, 200)
          }, 250)
        }, 250)
      }, 250)
    }, 250)
  }, 300)
}, 800)

// ── SCENARIO=split / splitbad ───────────────────────────────────────────────
if (isSplit) {
  setTimeout(() => {
    const body = document.body.textContent
    console.log('SPLIT: panel is shown ->', /Splits across 2 artists/.test(body))
    console.log('SPLIT: names the second artist ->', /Oxis/.test(body),
      '(it was nowhere on screen before)')
    console.log('SPLIT: shows its song ->', /tilapia/.test(body))
    // Scenario-aware: splitbad is 500 + 300, so counting "$500.00" twice would
    // report a failure that is only in the test.
    console.log('SPLIT: shows per-row amounts ->', SCENARIO === 'splitbad'
      ? /\$500\.00/.test(body) && /\$300\.00/.test(body)
      : (body.match(/\$500\.00/g) || []).length >= 2)
    if (SCENARIO === 'splitbad') {
      // 500 + 300 against a $1,000 invoice.
      console.log('SPLITBAD: mismatch is called out ->', /do not add up to the invoice amount/.test(body))
      console.log('SPLITBAD: shows both totals ->', /\$800\.00 ≠ \$1,000\.00/.test(body))
    } else {
      console.log('SPLIT: no false mismatch warning ->', !/do not add up/.test(body))
    }
    globalThis.__REPORTED__ = true
  }, 900)
}

// ── SCENARIO=artist ─────────────────────────────────────────────────────────
//
// The "Correct artist?" field is a PICKER now, not a text box. What has to hold:
//
//   · it is a button carrying the row's current name, not an <input>
//   · typing filters the roster+ledger list
//   · picking writes the CANONICAL spelling — the whole point, since the row
//     arrived holding "manila killa" and the roster says "Manila Killa"
//   · the edit un-ticks the confirmation, as every other field edit does
//   · a name NOBODY has heard of can still be entered: vendors submit
//     off-roster artists, and a picker that could only offer the roster would
//     refuse the case this page already warns about
if (isArtist) {
  const say = (...a) => console.log(...a)
  const txt = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim()
  // The picker's trigger: the control sitting in the CORRECT ARTIST? row. Found
  // by its title rather than by position, so reordering the checklist does not
  // silently point this at the category.
  const trigger = () => [...document.querySelectorAll('button')]
    .find((b) => /Pick from the roster/.test(b.getAttribute('title') || ''))
  // PickerMenu portals its menu to document.body, so the filter box is NOT
  // inside the card — querying the deck alone finds nothing.
  const filterBox = () => [...document.querySelectorAll('input')]
    .find((i) => /Manila Killa|Search|Filter|manila killa/i.test(i.placeholder || '') || i.getAttribute('data-picker') === '1')
  const menuRows = () => [...document.querySelectorAll('div[role="option"], button'), ...document.querySelectorAll('div')]

  setTimeout(() => {
    say('ARTIST: the field is a picker, not a text box ->', !!trigger())
    say('ARTIST: it carries the row\u2019s current name ->', /manila killa/.test(txt(trigger())))
    // The old control, so a regression to it is visible rather than merely
    // making the assertions above go quiet. Typed, because AMOUNT carries the
    // same '(empty)' placeholder — matching on the placeholder alone found the
    // amount box and reported a failure that was only in the test.
    const oldBox = [...document.querySelectorAll('input')]
      .find((i) => i.placeholder === '(empty)' && i.type === 'text')
    say('ARTIST: the bare text box is gone ->', !oldBox)

    click(trigger())
    setTimeout(() => {
      const list = () => document.body.textContent.replace(/\s+/g, ' ')
      say('ARTIST: the menu offers the roster ->',
        /Manila Killa/.test(list()) && /Kaidro/.test(list()) && /Oxis/.test(list()))

      // Type to filter.
      const box = [...document.querySelectorAll('input')].pop()
      say('ARTIST: it has a filter box ->', !!box)
      setValue(box, 'manila')
      setTimeout(() => {
        const shown = list()
        say('ARTIST: typing filters to the matches ->',
          /Manila Killa/.test(shown) && !/Kaidro/.test(shown))

        // Pick the canonical spelling.
        const opt = [...document.querySelectorAll('div,button')]
          .filter((e) => txt(e) === 'Manila Killa')
          .pop()
        say('ARTIST: the canonical spelling is offered ->', !!opt)
        click(opt)
        setTimeout(() => {
          const put = calls.put.find((c) => /\/bk\/entries\/10410$/.test(c.url))
          say('ARTIST: picking it saved ->', !!put)
          // THE assertion this scenario exists for: the row held the lowercase
          // drift and the picker wrote the roster's spelling.
          say('ARTIST: it wrote the ROSTER spelling, not the typed one ->',
            put?.body?.artist === 'Manila Killa')
          say('ARTIST: the card now shows it ->', /Manila Killa/.test(txt(trigger())))
          say('ARTIST: the edit un-ticked the confirmation ->',
            !![...document.querySelectorAll('button')]
              .find((b) => /Confirm this is right/.test(b.getAttribute('title') || '')))

          // ── An artist nobody has heard of still goes in ──────────────────
          click(trigger())
          setTimeout(() => {
            const box2 = [...document.querySelectorAll('input')].pop()
            setValue(box2, 'Roschmann')
            setTimeout(() => {
              const create = [...document.querySelectorAll('div,button')]
                .filter((e) => /Use .Roschmann./.test(txt(e)))
                .pop()
              say('ARTIST: an off-roster name is offered as an answer ->', !!create)
              if (create) click(create)
              setTimeout(() => {
                const last = calls.put[calls.put.length - 1]
                say('ARTIST: and it saves ->', last?.body?.artist === 'Roschmann')
                globalThis.__REPORTED__ = true
              }, 250)
            }, 200)
          }, 250)
        }, 250)
      }, 200)
    }, 250)
  }, 800)
}

setTimeout(() => {
  console.error = origError
  if (errors.length) {
    console.log('\n--- errors ---')
    for (const e of [...new Set(errors)]) console.log(e)
  } else {
    console.log('\nno errors captured')
  }
  globalThis.__DONE__ = true
}, 3200)
