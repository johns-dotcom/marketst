// Does the Banking header actually hold the month across a tab switch?
//
// This is the one claim the whole change rests on, and nothing else can see it:
//
//   `npm run smoke` renders a page in its LOADING state under renderToString,
//   where effects never fire — so the header never fetches, never summarises and
//   never draws a tie-out. It reports "ok" for a band that rendered nothing.
//
//   The two existing DOM harnesses mount BkLedger and BkBankMatching BARE, with
//   no BankShell and no route above them. That is deliberate (it is what proves
//   the store did not become a hidden dependency), but it means neither of them
//   has ever seen the shared header.
//
//   And the behaviour is a property of TWO mounts, not one: the bug being fixed
//   is that switching tabs unmounts the page and loses the selection. A harness
//   that renders one page can't fail on it.
//
// So this mounts the real BankShell over a real route, picks a statement,
// UNMOUNTS the whole tree, mounts the other tab, and asserts the selection and
// the tie-out are still there — and that the second mount cost ZERO extra
// /statements/:id reads, which is the other half of the claim (703KB each).
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import BankShell from '../src/components/BankShell'
import { calls } from './bankshell-api-stub.js'
import { __resetBankScope } from '../src/lib/bankScope'
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
const text = () => document.body.textContent || ''
const detailReads = () => calls.get.filter((c) => /^\/statements\/\d+$/.test(c.url)).length

// A stand-in for whichever page is under the bar. BankShell is the subject; the
// 5,000-line pages beneath it are not, and mounting one would make this a test
// of that page's own fetching.
const Stub = ({ name }) => <div data-page={name}>page:{name}</div>

function mountAt(path) {
  const el = document.getElementById('root')
  const root = createRoot(el)
  root.render(
    <MemoryRouter initialEntries={[path]}>
      <ThemeProvider>
        <Catch>
          <Routes>
            <Route path="/bk/bank-matching" element={<BankShell><Stub name="for-review" /></BankShell>} />
            <Route path="/bk/bank-ledger" element={<BankShell><Stub name="categorized" /></BankShell>} />
            <Route path="/bk/rules" element={<BankShell><Stub name="rules" /></BankShell>} />
          </Routes>
        </Catch>
      </ThemeProvider>
    </MemoryRouter>
  )
  return root
}

;(async () => {
  __resetBankScope()

  // ── 1. the header renders, unscoped ───────────────────────────────────────
  let root = mountAt('/bk/bank-matching')
  await sleep(600)
  say('MOUNT: the page under the shell rendered ->', /page:for-review/.test(text()))
  const sel = () => document.querySelector('select')
  say('HEADER: the statement picker is there ->', !!sel())
  say('HEADER: it offers every READY statement and not the parsing one ->',
    sel() && [...sel().options].map((o) => o.textContent.trim()).join(' | '))
  say('HEADER: unscoped, it says so ->', /across every statement/.test(text()))
  say('HEADER: and reports the global figure ->', /14\s*left to review/.test(text().replace(/\s+/g, ' ')))

  // ── 2. picking a month ties out ───────────────────────────────────────────
  const picker = sel()
  picker.value = '501'
  picker.dispatchEvent(new window.Event('change', { bubbles: true }))
  await sleep(700)
  say('PICK: the tie-out ran ->', /opened/.test(text()) && /closed/.test(text()))
  // 1000 + 100 − 280 = 820, and 820 is what the fixture statement prints.
  say('PICK: and it TIES ->', /✓ ties/.test(text()))
  say('PICK: the figure is now the statement\'s, not the ledger\'s ->',
    /2\s*left to review in May 2026/.test(text().replace(/\s+/g, ' ')))
  say('PICK: the disposition line is there ->', /booked here/.test(text()))
  const readsAfterPick = detailReads()
  say('PICK: statement reads so far ->', readsAfterPick)
  say('PICK: exactly one, not one per effect ->', readsAfterPick === 1)

  // ── 3. THE POINT: unmount, mount the other tab, month survives ────────────
  root.unmount()
  await sleep(100)
  say('SWITCH: the tree really was torn down ->', !/page:for-review/.test(text()))

  root = mountAt('/bk/bank-ledger')
  await sleep(700)
  say('SWITCH: the other tab mounted ->', /page:categorized/.test(text()))
  say('SWITCH: >>> the month SURVIVED the tab change ->', sel()?.value === '501')
  say('SWITCH: and so did the tie-out ->', /✓ ties/.test(text()))
  say('SWITCH: statement reads after the switch ->', detailReads())
  say('SWITCH: the cache spared the second 703KB read ->', detailReads() === readsAfterPick)

  // ── 4. a statement with no balances is not a failed check ─────────────────
  const p2 = sel()
  p2.value = '502'
  p2.dispatchEvent(new window.Event('change', { bubbles: true }))
  await sleep(700)
  say('PAYPAL: says there is nothing to tie against ->', /nothing to tie against/.test(text()))
  say('PAYPAL: and does NOT claim a drift ->', !/off by/.test(text()))

  // ── 5. Rules is in scope for the picker, out of scope for the tie-out ─────
  root.unmount(); await sleep(100)
  root = mountAt('/bk/rules')
  await sleep(700)
  say('RULES: the picker is still offered ->', !!sel())
  say('RULES: it says a rule is not scoped to a statement ->', /not scoped to the one above/.test(text()))
  say('RULES: and the disposition breakdown is withheld ->', !/booked here/.test(text()))

  say('rendered bytes:', (document.getElementById('root').innerHTML || '').length)
  say(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no errors captured')
  say('DONE')
  globalThis.__DONE__ = true
})()
