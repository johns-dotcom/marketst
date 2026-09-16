// Mount the PUBLIC vendor form in a real DOM and drive it.
//
// ── Why smoke was not enough ──
// `npm run smoke` runs the component BODY. Everything added on 2026-08-31 lives
// behind a conditional — the payment block is `{paymentPref && …}`, the file list
// is inside `{step === 2 && …}` — so none of that JSX was ever constructed by any
// check that ran. A green smoke plus a green `vite build` proved the module
// parses, and nothing about whether choosing "ACH" renders six fields or throws.
//
// This picks a payment method, reads the form back, walks to step 2 and attaches
// files, the way a vendor would.
//
//   cd client
//   ENTRY=scripts/vendorform-dom-entry.jsx API_STUB=scripts/vendorform-dom-api-stub.js \
//     npx vite build -c scripts/mywork-dom.vite.config.mjs
//   SCENARIO=ach JSDOM_PATH="file:///tmp/domtest/node_modules/jsdom/lib/api.js" \
//     node scripts/mywork-dom-check.mjs .domsmoke/out/vendorform-dom-entry.js
//
// SCENARIO ∈ ach | wire | wiredom | paypal | files | multi.
// PAGE=lab drives the SANDBOX copy instead of the live form. Worth running both:
// the lab is where changes are now built, and the four deltas that separate them
// are supposed to leave the fields untouched — this is what checks that they do.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import VendorSubmit from '../src/pages/VendorSubmit'
import VendorSubmitLab from '../src/pages/VendorSubmitLab'
import { ThemeProvider } from '../src/context/ThemeContext'
import { ToastProvider } from '../src/context/ToastContext'
import { CategoriesProvider } from '../src/context/CategoriesContext'
import { BoomRepsProvider } from '../src/context/BoomRepsContext'

const errors = []
window.addEventListener('error', (e) => errors.push('window.error: ' + e.message))
const origError = console.error
console.error = (...a) => { errors.push('console.error: ' + a.map(String).join(' ').slice(0, 400)) }

// ── The network, stubbed ─────────────────────────────────────────────────────
// VendorSubmit is public and uses bare fetch, not the axios client. Every route
// answers in the shape the page destructures. `payment-on-file` deliberately
// returns on_file:false: a vendor WITH details on file gets the confirm-instead-
// of-retype panel and the field block never renders, which is the opposite of
// what is under test here.
const FETCHES = []
// The SUBMITTED body, kept so a scenario can assert what left the page rather
// than what the page appears to hold. A multi-invoice submission is only really
// tested at the payload: the list can render four cards and still post one.
const POSTED = []
window.fetch = globalThis.fetch = async (url, opts) => {
  const u = String(url)
  FETCHES.push(u)
  if (u.includes('/api/vendor/submit') && opts && opts.body) POSTED.push(opts.body)
  const json = (body) => ({ ok: true, status: 200, json: async () => body })
  // STRINGS, not objects: rosterIndex does `name.toLowerCase()` over the array
  // directly. Getting this wrong threw on first render and looked exactly like a
  // broken page — worth the comment, since the shape is not obvious from the
  // fetch site.
  if (u.includes('/api/vendor/roster')) return json({ artists: ['Fixture Artist'] })
  if (u.includes('/api/vendor/lookup')) return json({ on_file: false })
  // ONFILE=1 reproduces a RETURNING vendor. The form then shows
  // "ACH ••••6789 — still correct?" and the field block is NOT rendered, which
  // looks identical to the fields being missing. This is the second reason
  // somebody reports them gone, and the harder one to spot.
  if (u.includes('/api/vendor/payment-on-file')) {
    return json(process.env.ONFILE === '1'
      ? { on_file: true, method: 'ACH', last4: '6789', holder_name: 'Returning Vendor' }
      : { on_file: false })
  }
  if (u.includes('/api/vendor/validate-invoice')) return json({ valid: true, issues: [] })
  if (u.includes('/api/vendor/validate-w9')) return json({ valid: true, issues: [] })
  if (u.includes('/api/vendor/parse-invoice')) return json({ parsed: {}, ai_warnings: [] })
  if (u.includes('/api/vendor/check-dup')) return json({ duplicate: false })
  if (u.includes('/api/vendor/check-similar')) return json({ similar: null })
  return json({ ok: true })
}

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
  <MemoryRouter initialEntries={['/submit']}>
    <ThemeProvider><ToastProvider><CategoriesProvider><BoomRepsProvider>
      <Catch>{process.env.PAGE === 'lab' ? <VendorSubmitLab /> : <VendorSubmit />}</Catch>
    </BoomRepsProvider></CategoriesProvider></ToastProvider></ThemeProvider>
  </MemoryRouter>
)

// ── Driving the form ─────────────────────────────────────────────────────────
// React tracks the DOM node's value, so setting `.value` directly is deduped
// away by the synthetic event system. Go through the prototype descriptor.
const setValue = (el, v) => {
  const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
  el.dispatchEvent(new window.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
}
const byPlaceholder = (re) => [...document.querySelectorAll('input')].find((i) => re.test(i.placeholder || ''))
/** Every field label currently on screen, trimmed of the required asterisk. */
const labels = () => [...document.querySelectorAll('label')]
  .map((l) => (l.textContent || '').replace(/\*/g, '').trim())
  .filter(Boolean)
const has = (list, name) => list.some((l) => l.toLowerCase().startsWith(name.toLowerCase()))
const methodSelect = () => [...document.querySelectorAll('select')]
  .find((s) => [...s.options].some((o) => o.value === 'ACH'))
const clickText = (re) => {
  const b = [...document.querySelectorAll('button')].find((x) => re.test(x.textContent || ''))
  if (b) b.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  return !!b
}

/** Fill the identity fields every scenario needs before a method can matter. */
function fillIdentity() {
  const name = byPlaceholder(/legal name|Full legal/i)
  const email = byPlaceholder(/your@email/i)
  if (name) setValue(name, 'Fixture Vendor')
  if (email) setValue(email, 'fixture@example.com')
  return { name: !!name, email: !!email }
}

const SCENARIO = process.env.SCENARIO || 'ach'
// A wire is two instruments. `wire` drives the INTERNATIONAL branch and
// `wiredom` the domestic one; both first assert that choosing "Wire" alone shows
// no coordinate fields at all, because the scope question is what decides them.
const REQUIRED = {
  ACH: ['Account number', 'Routing number', 'Account type', 'Name on the account', 'Bank name', 'Bank address'],
  Wire: ['IBAN or SWIFT/BIC', 'Name on the account', 'Bank name', 'Bank address', 'Beneficiary address'],
  WireDomestic: ['Routing number (ABA)', 'Account number', 'Name on the account', 'Bank name'],
  PayPal: ['PayPal email or handle'],
}
const scopeSelect = () => [...document.querySelectorAll('select')]
  .find((s) => [...s.options].some((o) => o.value === 'Domestic'))

setTimeout(() => {
  console.log('SCENARIO:', SCENARIO, '| PAGE:', process.env.PAGE === 'lab' ? 'VendorSubmitLab' : 'VendorSubmit')
  const id = fillIdentity()
  console.log('identity inputs found ->', JSON.stringify(id))

  // Bank Name was REMOVED from step 1 (it lives in the payment block now).
  // Mailing Address came BACK on 2026-08-31 as OPTIONAL — required would block a
  // submission over a field only needed to file a 1099 at year end, so the
  // asterisk is the assertion, not the presence.
  const before = labels()
  // What a vendor sees the moment the page loads, BEFORE picking a method. The
  // payment block is `{paymentPref && …}`, so on arrival none of it is on screen
  // — which reads as "the form is missing the bank fields" if you do not know
  // that. Printed rather than merely asserted, because the arrival state is the
  // thing people report.
  console.log('on arrival, before choosing a method ->', JSON.stringify(before))
  const mailingLabel = [...document.querySelectorAll('label')]
    .find((l) => /Mailing Address/i.test(l.textContent || ''))
  console.log('Mailing Address is present ->', !!mailingLabel)
  console.log('and is OPTIONAL (no asterisk) ->', mailingLabel ? !mailingLabel.textContent.includes('*') : 'n/a')
  console.log('and says why it is asked for ->',
    mailingLabel ? /1099/.test(mailingLabel.textContent) : 'n/a')
  console.log('standalone Bank Name is gone ->', !has(before, 'Bank Name'))

  const sel = methodSelect()
  console.log('payment-method select found ->', !!sel)
  if (!sel) { globalThis.__REPORTED__ = true; return }

  const method = (SCENARIO === 'wire' || SCENARIO === 'wiredom') ? 'Wire'
    : SCENARIO === 'paypal' ? 'PayPal' : 'ACH'
  setValue(sel, method)

  setTimeout(() => {
    // Wire branches on scope, so the coordinate fields must NOT be on screen yet.
    if (method === 'Wire') {
      const pre = labels()
      console.log('Wire: scope selector present ->', !!scopeSelect())
      console.log('Wire: offers US + outside-US ->',
        scopeSelect() ? JSON.stringify([...scopeSelect().options].map((o) => o.value).filter(Boolean)) : 'n/a')
      console.log('Wire: no coordinate fields before choosing a scope ->',
        !has(pre, 'IBAN') && !has(pre, 'Routing number') && !has(pre, 'Account number'))
      const want = SCENARIO === 'wiredom' ? 'Domestic' : 'International'
      if (scopeSelect()) setValue(scopeSelect(), want)
    }
    const L = labels()
    console.log(`${method}: fields on screen ->`, JSON.stringify(L.filter((x) => !/^(Email|Preferred Payment|Your Legal|Additional)/i.test(x))))
    const key = SCENARIO === 'wiredom' ? 'WireDomestic' : method
    for (const f of REQUIRED[key]) console.log(`${key}: has "${f}" ->`, has(L, f))

    if (method === 'ACH') {
      // A select, not a text box — the whole point of the field.
      const t = [...document.querySelectorAll('select')]
        .find((s) => [...s.options].some((o) => o.value === 'Checking'))
      console.log('ACH: account type is a select ->', !!t)
      console.log('ACH: offers exactly Checking + Savings ->',
        t ? JSON.stringify([...t.options].map((o) => o.value).filter(Boolean)) : 'n/a')
      console.log('ACH: no wire-only fields leaked ->',
        !has(L, 'Beneficiary address') && !has(L, 'IBAN'))
    }
    const labelFor = (re) => [...document.querySelectorAll('label')].find((l) => re.test(l.textContent || ''))
    if (SCENARIO === 'wire') {
      const lab = labelFor(/Intermediary/i)
      console.log('Wire: intermediary bank present ->', !!lab)
      console.log('Wire: and marked OPTIONAL (no asterisk) ->', lab ? !lab.textContent.includes('*') : 'n/a')
      console.log('Wire: no domestic ABA field ->', !has(L, 'Routing number (ABA)'))
      // The conditional one. With nothing typed yet there is no SWIFT, so the
      // account number must NOT be demanded — an IBAN would already contain it.
      const acct = labelFor(/^\s*Account number/i)
      console.log('Wire intl: account number is present but NOT required ->',
        !!acct && !acct.textContent.includes('*'))
    }
    if (SCENARIO === 'wiredom') {
      console.log('Wire domestic: no IBAN/SWIFT asked for ->', !has(L, 'IBAN'))
      console.log('Wire domestic: no beneficiary address demanded ->', !has(L, 'Beneficiary address'))
      const bankAddr = labelFor(/Bank address/i)
      console.log('Wire domestic: bank address present but OPTIONAL ->',
        !!bankAddr && !bankAddr.textContent.includes('*'))
    }
    if (method === 'PayPal') {
      // PayPal vendors have no bank. Asking them for one is what pushed the bank
      // name into the payment block in the first place.
      console.log('PayPal: no bank fields at all ->',
        !has(L, 'Bank name') && !has(L, 'Bank address') && !has(L, 'Account number'))
    }

    // The payment-on-file lookup is debounced 500ms off the email field, so it
    // resolves AFTER the read above. Reading too early is why the first attempt
    // at this reported the fields present and the panel absent — the effect had
    // simply not fired yet. Give it its own, later look.
    if (process.env.ONFILE === '1') {
      setTimeout(() => {
        const L2 = labels()
        const body = document.body.textContent
        console.log('ONFILE: panel offers to reuse ->', /still correct/.test(body))
        console.log('ONFILE: shows the masked account ->', /••••6789/.test(body))
        console.log('ONFILE: field block is hidden ->', !has(L2, 'Account number'))
        console.log('ONFILE: labels now ->', JSON.stringify(L2))
        globalThis.__REPORTED__ = true
      }, 1400)
      return
    }
    if (SCENARIO !== 'files') { globalThis.__REPORTED__ = true; return }
    globalThis.__REPORTED__ = true
  }, 300)
}, 1200)

// ── files: fill step 1 for real, walk to step 2, attach ──────────────────────
if ((process.env.SCENARIO || 'ach') === 'files') {
  setTimeout(() => {
    console.log('\n--- files ---')
    // Every ACH field, so goToStep2's payMissing gate actually passes. If this
    // does not advance, the gate is what is being reported, and that is useful.
    const vals = {
      '000123456789': /000123456789/,
      '021000021': /9 digits/,
    }
    for (const [v, re] of Object.entries(vals)) {
      const el = byPlaceholder(re)
      if (el) setValue(el, v)
    }
    const typeSel = [...document.querySelectorAll('select')]
      .find((s) => [...s.options].some((o) => o.value === 'Checking'))
    if (typeSel) setValue(typeSel, 'Checking')
    // Holder / bank name / bank address have no distinctive placeholder between
    // them, so fill by label position instead.
    for (const l of document.querySelectorAll('label')) {
      const t = (l.textContent || '').toLowerCase()
      const input = l.parentElement && l.parentElement.querySelector('input')
      if (!input || input.value) continue
      if (t.includes('name on the account')) setValue(input, 'Fixture Vendor')
      else if (t.includes('bank name')) setValue(input, 'Test Bank')
      else if (t.includes('bank address')) setValue(input, '1 Bank St')
    }
    setTimeout(() => {
      const advanced = clickText(/Next — Upload Documents/i)
      console.log('clicked Next ->', advanced)
      setTimeout(() => {
        const err = document.body.textContent.match(/Please enter your [^.]*/)
        if (err) console.log('step 1 refused with ->', JSON.stringify(err[0].slice(0, 90)))
        const multi = [...document.querySelectorAll('input[type=file]')].find((i) => i.multiple)
        console.log('multi-file input present ->', !!multi)
        if (!multi) { globalThis.__REPORTED__ = true; return }

        const mk = (n) => new window.File(['%PDF-1.4'], n, { type: 'application/pdf' })
        Object.defineProperty(multi, 'files', { value: [mk('a.pdf'), mk('b.pdf'), mk('c.pdf')], configurable: true })
        multi.dispatchEvent(new window.Event('change', { bubbles: true }))
        setTimeout(() => {
          const body = document.body.textContent
          console.log('all three listed ->', /a\.pdf/.test(body) && /b\.pdf/.test(body) && /c\.pdf/.test(body))
          const removes = [...document.querySelectorAll('button[aria-label^="Remove "]')]
            .filter((b) => /\.pdf$/.test(b.getAttribute('aria-label') || ''))
          console.log('remove buttons rendered ->', removes.length, '(expect 3)')
          if (removes.length) {
            removes[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
            setTimeout(() => {
              const after = document.body.textContent
              console.log('after removing a.pdf, it is gone ->', !/a\.pdf/.test(after))
              console.log('and the other two remain ->', /b\.pdf/.test(after) && /c\.pdf/.test(after))
              globalThis.__REPORTED__ = true
            }, 200)
          } else { globalThis.__REPORTED__ = true }
        }, 300)
      }, 400)
    }, 300)
  }, 2000)
}

// ── multi: several invoices in one submission ────────────────────────────────
//
// The invoices are declared on STEP 2 — one row per invoice, each with its own
// document and number — and step 3 then pages through the project questions.
// The feature is only half visible in the DOM: the other half is the PAYLOAD,
// because a list can render two rows and post one.
if ((process.env.SCENARIO || 'ach') === 'multi') {
  // NODE's File, not jsdom's. `mywork-dom-check.mjs` copies jsdom's
  // window/document onto globalThis but NOT FormData/File/Blob, so the page's
  // `new FormData()` is Node's — and Node's FormData stringifies any value that
  // is not a Node Blob. A jsdom File went in and `fd.get('invoice_file_0')` came
  // out as the 13-character string "[object File]", which still passes a truthy
  // check, so the payload assertions reported the files present and their names
  // null.
  const FileCtor = globalThis.File || window.File
  const mkFile = (n) => new FileCtor(['%PDF-1.4'], n, { type: 'application/pdf' })
  const attach = (input, file) => {
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    input.dispatchEvent(new window.Event('change', { bubbles: true }))
  }
  const labelled = (re) => [...document.querySelectorAll('label')].filter((l) => re.test(l.textContent || ''))
  const fileInputUnder = (lab) => lab && lab.parentElement && lab.parentElement.querySelector('input[type=file]')
  const numberInputs = () => [...document.querySelectorAll('input')]
    .filter((i) => /INV-2024-001/.test(i.placeholder || ''))
  const selectWith = (value) => [...document.querySelectorAll('select')]
    .find((s2) => [...s2.options].some((o) => o.value === value))

  /** Fill the project answers for whichever invoice step 3 is showing. */
  const fillProject = (artist, amount, done) => {
    const openPicker = [...document.querySelectorAll('button')]
      .find((b) => /Search the roster|Choose an artist|artist/i.test(b.textContent || '')
        && !/Add another|Submit|Back|Next|Prev|invoice/i.test(b.textContent || ''))
    if (openPicker) openPicker.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    setTimeout(() => {
      const q = [...document.querySelectorAll('input')].find((i) => /search|artist/i.test(i.placeholder || ''))
      if (q) setValue(q, artist)
      setTimeout(() => {
        // TYPING IS NOT PICKING. The artist is assigned when a row is clicked,
        // and the row commits on MOUSEDOWN (the list closes on blur, so a click
        // never lands). Without this the form sits on "an artist or project"
        // with the name visibly in the box.
        const row = [...document.querySelectorAll('div')]
          .find((d) => (d.textContent || '').trim() === artist && d.children.length === 0)
        if (row) row.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }))
        const song = byPlaceholder(/song|track/i)
        if (song) setValue(song, 'Fixture Song')
        // The ARTIST ROW's amount, not the social row's optional one — they are
        // both money boxes and the social one comes second in the DOM.
        const amt = byPlaceholder(/\$ Amount/i)
        if (amt) setValue(amt, String(amount))
        const cat = selectWith('Marketing')
        if (cat) setValue(cat, 'Marketing')
        const rep = [...document.querySelectorAll('select')]
          .find((s2) => [...s2.options].some((o) => /^(John|Felipe|Tyler)$/.test(o.value)))
        if (rep) setValue(rep, [...rep.options].map((o) => o.value).filter(Boolean)[0])
        const handle = byPlaceholder(/@yourhandle/i)
        if (handle) setValue(handle, '@fixture')
        setTimeout(done, 300)
      }, 250)
    }, 250)
  }

  setTimeout(() => {
    console.log('\n--- multi ---')
    const vals = { '000123456789': /000123456789/, '021000021': /9 digits/ }
    for (const [v, re] of Object.entries(vals)) {
      const el = byPlaceholder(re)
      if (el) setValue(el, v)
    }
    const typeSel = selectWith('Checking')
    if (typeSel) setValue(typeSel, 'Checking')
    for (const l of document.querySelectorAll('label')) {
      const t = (l.textContent || '').toLowerCase()
      const input = l.parentElement && l.parentElement.querySelector('input')
      if (!input || input.value) continue
      if (t.includes('name on the account')) setValue(input, 'Fixture Vendor')
      else if (t.includes('bank name')) setValue(input, 'Test Bank')
      else if (t.includes('bank address')) setValue(input, '1 Bank St')
    }

    setTimeout(() => {
      clickText(/Next — Upload Documents/i)
      setTimeout(() => {
        console.log('\nSTEP 2 IS THE LIST')
        console.log('one invoice row to start ->', numberInputs().length === 1)
        console.log('the W9 is asked ONCE, above the list ->', labelled(/W9 or W8/i).length === 1)
        console.log('and says one form covers them all ->',
          /covers every invoice/i.test(document.body.textContent))
        console.log('an "add another invoice" button is here on step 2 ->',
          [...document.querySelectorAll('button')].some((b) => /Add another invoice/i.test(b.textContent || '')))

        // Invoice 1.
        setValue(numberInputs()[0], 'INV-1')
        attach(fileInputUnder(labelled(/Invoice File/i)[0]), mkFile('first.pdf'))
        attach(fileInputUnder(labelled(/W9 or W8/i)[0]), mkFile('w9.pdf'))

        setTimeout(() => {
          clickText(/Add another invoice/i)
          setTimeout(() => {
            const nums = numberInputs()
            console.log('\nadding a row does not leave step 2 ->', nums.length === 2)
            console.log('the first row keeps its number ->', nums[0] && nums[0].value === 'INV-1')
            console.log('and its document ->', /first\.pdf/.test(document.body.textContent))
            console.log('the new row is empty ->', nums[1] && nums[1].value === '')
            console.log('the W9 is still asked only once ->', labelled(/W9 or W8/i).length === 1)
            console.log('rows are numbered ->', /Invoice 1 of 2/.test(document.body.textContent)
              && /Invoice 2 of 2/.test(document.body.textContent))

            // Invoice 2.
            setValue(numberInputs()[1], 'INV-2')
            attach(fileInputUnder(labelled(/Invoice File/i)[1]), mkFile('second.pdf'))

            setTimeout(() => {
              clickText(/Next — Review & Submit/i)
              setTimeout(() => {
                console.log('\nSTEP 3 PAGES THROUGH THEM')
                const body = document.body.textContent
                console.log('it says which invoice is being answered ->', /Invoice 1 of 2/.test(body))
                console.log('a Next-invoice control exists ->',
                  [...document.querySelectorAll('button')].some((b) => /Next ›|Next invoice/i.test(b.textContent || '')))

                fillProject('Fixture Artist', 100, () => {
                  const nextBtn = [...document.querySelectorAll('button')]
                    .find((b) => /Next invoice/i.test(b.textContent || ''))
                    || [...document.querySelectorAll('button')].find((b) => /Next ›/.test(b.textContent || ''))
                  if (nextBtn) nextBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
                  setTimeout(() => {
                    console.log('moving on shows invoice 2 ->', /Invoice 2 of 2/.test(document.body.textContent))
                    const amt = byPlaceholder(/\$ Amount/i)
                    console.log("invoice 2 starts blank, not invoice 1's answers ->",
                      !!amt && amt.value === '')

                    fillProject('Fixture Artist', 250, () => {
                      const sub = [...document.querySelectorAll('button')]
                        .find((b) => /Submit \d+ Invoices/i.test(b.textContent || ''))
                      console.log('\nthe submit button counts the batch ->', !!sub,
                        sub ? JSON.stringify(sub.textContent.trim()) : '')
                      if (sub) sub.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
                      setTimeout(() => {
                        const fd = POSTED[POSTED.length - 1]
                        console.log('\nTHE PAYLOAD')
                        console.log('the form posted something ->', !!fd)
                        if (!fd) { globalThis.__REPORTED__ = true; return }
                        let parsed = null
                        try { parsed = JSON.parse(fd.get('invoices')) } catch {}
                        console.log('it sent an `invoices` list ->', Array.isArray(parsed))
                        console.log('with BOTH invoices ->', parsed ? parsed.length : 0, '(expect 2)')
                        console.log('each with its own number ->',
                          parsed ? JSON.stringify(parsed.map((x) => x.invoice_number)) : 'n/a')
                        console.log('and its own amount ->',
                          parsed ? JSON.stringify(parsed.map((x) => x.amount)) : 'n/a')
                        console.log('each document under its own key ->',
                          !!fd.get('invoice_file_0') && !!fd.get('invoice_file_1'))
                        console.log('documents are not shuffled ->',
                          (fd.get('invoice_file_0') || {}).name === 'first.pdf'
                          && (fd.get('invoice_file_1') || {}).name === 'second.pdf')
                        console.log('the single-invoice keys are NOT used for a batch ->',
                          !fd.get('file') && !fd.get('invoice_number_hint'))
                        console.log('the W9 is sent once ->', !!fd.get('w9_file'))
                        console.log('the vendor block is sent once ->',
                          fd.get('vendor_name') === 'Fixture Vendor' && !!fd.get('payment_account_number'))
                        globalThis.__REPORTED__ = true
                      }, 600)
                    })
                  }, 500)
                })
              }, 900)
            }, 300)
          }, 400)
        }, 400)
      }, 500)
    }, 400)
  }, 2000)
}

function finish() {
  console.error = origError
  console.log('\nrendered bytes:', document.getElementById('root').innerHTML.length)
  if (errors.length) {
    console.log('--- errors ---')
    for (const e of [...new Set(errors)]) console.log(e)
  } else {
    console.log('no errors captured')
  }
  globalThis.__DONE__ = true
}
setTimeout(finish, (process.env.SCENARIO || 'ach') === 'multi' ? 12000 : 4200)
