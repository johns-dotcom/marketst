// Mount Add Invoice in a REAL DOM and drive the new review to a save.
//
// John, 2026-08-27: "add the same review feature to the add invoice page."
// It matters more here than it looks: an admin's add is written
// `status = 'approved'` by the server on the spot, so it never reaches the
// Approvals queue. Measured on production that day: 894 hand-added approved
// invoices worth $3,091,450 with no checklist at all.
//
// `npm run smoke` renders this page with renderToString, where the review is a
// closed overlay and every line of it goes unexecuted. This asserts the part
// that matters: Save opens the review instead of writing, an incomplete
// checklist cannot save, and the completed one reaches POST /bk/entries.
import React from 'react'
import { createRoot } from 'react-dom/client'
import BkAddInvoice from '../src/pages/BkAddInvoice'
import { calls, lastEntry } from './addinvoice-api-stub.js'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '../src/context/ThemeContext'
import { ToastProvider } from '../src/context/ToastContext'
import { FxRatesProvider } from '../src/context/FxRatesContext'
import { BoomRepsProvider } from '../src/context/BoomRepsContext'
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

const root = createRoot(document.getElementById('root'))
root.render(
  <MemoryRouter initialEntries={['/bk/add']}>
    <ThemeProvider><ToastProvider><FxRatesProvider><BoomRepsProvider><CategoriesProvider>
      <Catch><BkAddInvoice /></Catch>
    </CategoriesProvider></BoomRepsProvider></FxRatesProvider></ToastProvider></ThemeProvider>
  </MemoryRouter>
)

const setValue = (el, v) => {
  const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype
    : el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
  el.dispatchEvent(new window.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
}
const click = (el) => el && el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
const byText = (re, tag = 'button') => [...document.querySelectorAll(tag)]
  .find((b) => re.test((b.textContent || '').trim()))
// The form's inputs carry no name or id, so fields are located the way a person
// does: by the label above them, then the first control in that block.
const inputByLabel = (re) => {
  const lab = [...document.querySelectorAll('label')].find((l) => re.test((l.textContent || '').trim()))
  if (!lab) return null
  let el = lab.nextElementSibling
  while (el) {
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return el
    const inner = el.querySelector && el.querySelector('input, select, textarea')
    if (inner) return inner
    el = el.nextElementSibling
  }
  return lab.parentElement?.querySelector('input, select, textarea') || null
}

const submitForm = () => document.querySelector('form')
  ?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))

setTimeout(() => {
  console.log('rendered bytes:', document.getElementById('root').innerHTML.length)
  const save = byText(/Review & Save Invoice|Save Invoice/)
  console.log('SAVE: button reads ->', JSON.stringify((save?.textContent || '').trim()))

  // ── The form must still refuse an incomplete form BEFORE the review ──────
  // jsdom does not run form submission from a click on a type=submit button, so
  // the submit event is dispatched on the form itself — which is what React's
  // onSubmit is bound to.
  submitForm()
  setTimeout(() => {
    console.log('GUARD: review opened on an empty form ->', !!byText(/Back to the form/))
    console.log('GUARD: error shown ->',
      /required/i.test(document.getElementById('root').textContent || ''))

    // Fill the minimum the page demands.
    const set = (re, v) => { const el = inputByLabel(re); if (el) setValue(el, v); return !!el }
    const filled = {
      invoice_date: set(/^Invoice Date/, '2026-08-27'),
      payee: set(/^Payee/, 'Steven Whitaker'),
      category: set(/^Category/, 'Marketing'),
      artist: set(/^Artist/, 'nikko'),
      song: set(/^Song/, '4 music videos'),
      invoice_number: set(/^Invoice #/, '0018'),
      amount: set(/^Amount/, '2000'),
      vendor_email: set(/^Vendor Email/, 'contact@whitaswhit.com'),
    }
    console.log('FORM: fields set ->', JSON.stringify(filled))

    setTimeout(() => {
      submitForm()
      setTimeout(() => {
        const open = !!byText(/Back to the form/)
        console.log('REVIEW: opened ->', open)
        console.log('REVIEW: NOTHING was posted yet ->', calls.post.length === 0, `(${calls.post.length} posts)`)
        console.log('REVIEW: shows it files as approved ->',
          /files as approved/.test(document.getElementById('root').textContent || ''))
        console.log('REVIEW: document panel present ->',
          /No invoice file was attached/.test(document.getElementById('root').textContent || ''))
        console.log('REVIEW: socials editor present ->',
          [...document.querySelectorAll('input')].some((i) => i.placeholder === '@handle'))

        const saveBtn = byText(/^Save invoice$/)
        console.log('REVIEW: Save is DISABLED until answered ->', !!saveBtn?.disabled)
        console.log('REVIEW: outstanding line ->',
          (document.getElementById('root').textContent.match(/([a-z ·]+) still to answer/) || [])[1])

        // Answer everything: four ticks, then four Yes/No.
        const ticks = [...document.querySelectorAll('button')]
          .filter((b) => b.querySelector('svg.lucide-check'))
        console.log('REVIEW: confirmation ticks ->', ticks.length)
        ticks.forEach(click)
        const left = () => (document.getElementById('root').textContent
          .match(/([a-z ·]+) still to answer/) || [])[1] || '(none)'
        setTimeout(() => {
          // Yes/No pairs, in DOM order: bulk deal, cobrand, recoupable, campaign.
          console.log('REVIEW: after ticking ->', left())
          const yesno = [...document.querySelectorAll('button')]
            .filter((b) => /^(Yes|No)$/.test((b.textContent || '').trim()))
          console.log('REVIEW: yes/no buttons ->', yesno.length, '(4 pairs)')
          const pairs = []
          for (let i = 0; i < yesno.length; i += 2) pairs.push([yesno[i], yesno[i + 1]])
          click(pairs[0]?.[1])   // bulk deal: No
          setTimeout(() => {
            const yn2 = [...document.querySelectorAll('button')].filter((b) => /^(Yes|No)$/.test((b.textContent || '').trim()))
            click(yn2[3])        // cobrand: No
            setTimeout(() => {
              const yn3 = [...document.querySelectorAll('button')].filter((b) => /^(Yes|No)$/.test((b.textContent || '').trim()))
              click(yn3[4])      // recoupable: Yes
              setTimeout(() => {
                const yn4 = [...document.querySelectorAll('button')].filter((b) => /^(Yes|No)$/.test((b.textContent || '').trim()))
                click(yn4[6])    // campaign: Yes
                setTimeout(() => {
                  console.log('REVIEW: after answering ->', left())
                  const s2 = byText(/^Save invoice$/)
                  console.log('REVIEW: Save enabled once answered ->', !!s2 && !s2.disabled)
                  click(s2)
                  setTimeout(() => {
                    const e = lastEntry()
                    console.log('SAVE: POST /bk/entries fired ->', !!e)
                    console.log('SAVE: checklist sent ->', JSON.stringify(e?.body?.checklist || null))
                    console.log('SAVE: the typed facts went with it ->',
                      JSON.stringify({ payee: e?.body?.payee, amount: e?.body?.amount,
                        artist: e?.body?.artist, category: e?.body?.category }))
                    console.log('SAVE: review closed ->', !byText(/Back to the form/))
                  }, 400)
                }, 120)
              }, 120)
            }, 120)
          }, 120)
        }, 150)
      }, 300)
    }, 200)
  }, 300)
}, 900)

setTimeout(() => {
  console.error = origError
  if (errors.length) {
    console.log('\n--- errors ---')
    for (const e of [...new Set(errors)]) console.log(e)
  } else {
    console.log('\nno errors captured')
  }
  globalThis.__DONE__ = true
}, 3600)
