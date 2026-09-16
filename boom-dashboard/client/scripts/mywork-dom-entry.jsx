// Mount My Work in a real DOM so EFFECTS RUN and the data branches execute.
//
// `npm run smoke` renders with renderToString, where effects never fire — so the
// page renders in its LOADING state and every branch that needs data goes
// unexecuted. That is why a white page can survive a green smoke run. This mounts
// for real against a stubbed api, waits for the fetch to resolve, and reports
// whatever actually throws.
import React from 'react'
import { createRoot } from 'react-dom/client'
import MyWork from '../src/pages/MyWork'
import { calls } from './mywork-dom-api-stub.js'
import { MemoryRouter } from 'react-router-dom'
// The REAL provider stack, as main.jsx supplies and scripts/smoke-render.mjs
// mirrors. Without ThemeProvider, EmailPreviewModal throws
// "Cannot destructure property 'theme' of useTheme(...)" the moment the
// assignment preview is raised — the error boundary then renders null and the
// whole page disappears, which read as "assigning wiped the list".
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
  componentDidCatch(err, info) {
    errors.push('THROWN: ' + (err && err.message))
    errors.push('STACK: ' + String((err && err.stack) || '').split('\n').slice(0, 6).join(' | '))
  }
  render() { return this.state.err ? null : this.props.children }
}

const root = createRoot(document.getElementById('root'))
root.render(
  <MemoryRouter initialEntries={['/my-work']}>
    <ThemeProvider>
      <ToastProvider>
        <FxRatesProvider>
          <BoomRepsProvider>
            <CategoriesProvider>
              <Catch><MyWork /></Catch>
            </CategoriesProvider>
          </BoomRepsProvider>
        </FxRatesProvider>
      </ToastProvider>
    </ThemeProvider>
  </MemoryRouter>
)

// Wrapped rather than top-level await: the build target has no TLA.
// ── Does typing in the notes pane actually work? ──────────────────────────────
// John, 2026-08-27: "the notes typing feature doesn't work, it lags every
// letter." Two causes, both asserted here: the textarea had no local state (so
// it rendered the SERVER's copy back on every keystroke), and each debounced
// write called fetchData(), which sets loading=true and swapped the whole pane
// for a skeleton. This types into it for real and checks what comes back.
function typeInto(el, text) {
  // React tracks the DOM node's value; set it through the descriptor so the
  // synthetic onChange sees the new value rather than being deduped away.
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  for (const ch of text) {
    setter.call(el, el.value + ch)
    el.dispatchEvent(new window.Event('input', { bubbles: true }))
  }
}

const SCENARIO = process.env.SCENARIO || 'typing'
setTimeout(() => {
  console.log('SCENARIO:', SCENARIO)
  const ta = SCENARIO === 'typing' ? document.querySelector('textarea') : null
  const getsBefore = calls.get.length
  if (SCENARIO !== 'typing') { /* skipped */ } else if (!ta) {
    console.log('TYPING: no textarea found — the pane did not render')
  } else {
    // The task opens with a note already in it, so the expected result is that
    // note PLUS what was typed — asserting against the typed text alone reported
    // a failure that was only in the test.
    const before = ta.value
    typeInto(ta, 'hello notes')
    console.log('TYPING: value ->', JSON.stringify(ta.value))
    console.log('TYPING: every character landed, in order ->', ta.value === before + 'hello notes')
    console.log('TYPING: api.get calls during typing ->', calls.get.length - getsBefore, '(must be 0 — a refetch renders the skeleton)')
  }
  // ── Does "New Task" do anything? ────────────────────────────────────────────
  // John, 2026-08-27: "the new task button doesnt work". It called
  // setShowAddTask(true), and the form that flag gated was deleted in the
  // two-pane rebuild — `showAddTask` had exactly one use, its own declaration.
  const newBtn = SCENARIO === 'newtask' ? [...document.querySelectorAll('button')]
    .find((b) => /New Task|Adding/i.test(b.textContent || '')) : null
  if (SCENARIO === 'newtask') console.log('NEW TASK: button found ->', !!newBtn)
  if (newBtn) {
    const postsBefore = calls.post.length
    newBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    setTimeout(() => {
      const posts = calls.post.filter((c) => c.url.includes('/team/tasks'))
      console.log('NEW TASK: POST /team/tasks calls ->', posts.length - postsBefore)
      console.log('NEW TASK: body ->', JSON.stringify(posts[posts.length - 1]?.body || null))
      // The created row must be SELECTED — the detail pane is where you type.
      const ta = document.querySelector('textarea')
      const rows = document.querySelectorAll('li')
      console.log('NEW TASK: rows in the list now ->', rows.length)
      console.log('NEW TASK: detail pane present ->', !!ta)
    }, 600)
  }
  // ── @mention: hand a task to somebody ───────────────────────────────────────
  // John asked for this back after the rebuild dropped it. It used to live in the
  // add-task form's description; it now lives on the detail pane's title.
  const title = SCENARIO === 'mention' ? document.querySelector('input[placeholder^="Untitled"]') : null
  if (SCENARIO === 'mention') console.log('MENTION: title input found ->', !!title)
  if (title) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    console.log('MENTION: rows BEFORE ->', document.querySelectorAll('li').length)
    setter.call(title, 'call @dy')
    title.dispatchEvent(new window.Event('input', { bubbles: true }))
    setTimeout(() => {
      const menu = [...document.querySelectorAll('button')].filter((b) => /Dylan/.test(b.textContent || ''))
      console.log('MENTION: roster menu offers Dylan ->', menu.length > 0)
      if (menu.length) {
        const putsBefore = calls.put.length
        menu[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
        setTimeout(() => {
          const assigns = calls.put.filter((c) => /\/assign$/.test(c.url))
          console.log('MENTION: PUT …/assign calls ->', assigns.length)
          console.log('MENTION: body ->', JSON.stringify(assigns[0]?.body || null))
          console.log('MENTION: title had the @dy stripped ->', JSON.stringify(title.value))
          const rows = document.querySelectorAll('li')
          // Exactly ONE row should go: the task that moved owner. The list is
          // scoped WHERE user_id, so leaving it on screen would show a task the
          // next refresh makes vanish.
          console.log('MENTION: rows left in the list ->', rows.length, '(started at 8 — one handed over)')
          const body = document.body.innerHTML
          console.log('MENTION: notification preview raised ->', /Send task assignment notification/.test(body))
          console.log('MENTION: any modal text? ->', /assignment|notification|Assignee/i.test(body))
          console.log('MENTION: list empty-state text? ->', /No tasks here|Nothing matches/.test(body))
        }, 500)
      }
    }, 250)
  }
  const html = document.getElementById('root').innerHTML
  console.error = origError
  console.log('rendered bytes:', html.length)
  // Errors are reported by finish() below — this used to print here, BEFORE the
  // interaction scenarios had run, so a throw during a click was invisible.
  console.log('grip handles rendered ->', (html.match(/lucide-grip-vertical/g) || []).length)
  globalThis.__REPORTED__ = true
}, 1500)

function finish() {
  console.error = origError
  if (errors.length) {
    console.log('\n--- errors ---')
    for (const e of [...new Set(errors)]) console.log(e)
  } else {
    console.log('no errors captured')
  }
  globalThis.__DONE__ = true
}
// Runs after every scenario's own timers have had their turn.
setTimeout(finish, 3600)
