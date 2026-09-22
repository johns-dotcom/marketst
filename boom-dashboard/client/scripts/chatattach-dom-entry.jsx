// Do chat attachments actually RENDER, and does the no-token-in-a-URL rule hold?
//
// `npm run smoke` cannot answer either. It renders under `renderToString`, where
// effects never fire — so Messages only ever draws its loading skeleton and
// reports "ok" for a page that drew no messages at all, let alone an attachment.
// Every attachment is behind `/chat/channels/:id/messages`, which is exactly the
// branch smoke does not reach.
//
// Four things can go wrong here and none of them throws:
//
//   an image renders as a download chip                  → the feature looks broken
//   an inline-stored image never resolves its blob       → a permanent skeleton
//   a PDF renders as an <img>                            → a broken-image icon
//   a session token ends up in an <img src>/<a href>     → a credential in history,
//                                                           Referer, and proxy logs
//
// That last one is the reason this file exists. It is invisible in review and it
// is one assertion here.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Messages from '../src/pages/Messages'
import api, { calls } from './chatattach-api-stub.js'
import { ThemeProvider } from '../src/context/ThemeContext'
import { ToastProvider } from '../src/context/ToastContext'

const errors = []
window.addEventListener('error', (e) => errors.push('window.error: ' + e.message))
console.error = (...a) => { errors.push('console.error: ' + a.map(String).join(' ').slice(0, 300)) }

class Catch extends React.Component {
  constructor(p) { super(p); this.state = { err: null } }
  static getDerivedStateFromError(err) { return { err } }
  render() { return this.state.err ? React.createElement('div', { id: 'boom' }, String(this.state.err)) : this.props.children }
}

const say = (m) => console.log(m)
let passed = 0
const assert = (name, cond) => { if (cond) passed += 1; say(`  ${name} -> ${!!cond}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const textOf = (n) => (n?.textContent || '').replace(/\s+/g, ' ').trim()

// The token the stub would be sending. If this string turns up in ANY src or
// href the page rendered, a credential just went into browser history.
const SESSION_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.SESSION-TOKEN-MUST-NOT-LEAK.sig'
try { localStorage.setItem('token', SESSION_TOKEN) } catch {}

async function main() {
  const host = document.getElementById('root')
  createRoot(host).render(
    <Catch>
      <MemoryRouter initialEntries={['/messages/1']}>
        <ThemeProvider>
          <ToastProvider>
            <Routes>
              <Route path="/messages/:channelId" element={<Messages />} />
            </Routes>
          </ToastProvider>
        </ThemeProvider>
      </MemoryRouter>
    </Catch>
  )
  await sleep(900)

  const boom = document.getElementById('boom')
  assert('the page did not throw', !boom)
  if (boom) { say('  threw: ' + textOf(boom)); say('\nDONE'); globalThis.__DONE__ = true; return }
  assert('no console.error during render', errors.length === 0)
  if (errors.length) errors.slice(0, 3).forEach((e) => say('    ' + e))

  const d = () => textOf(host)
  assert('the messages actually rendered (not the skeleton)', /cover art, straight from the bucket/.test(d()))

  say('\n  IMAGES RENDER INLINE')
  const imgs = [...host.querySelectorAll('img')]
  assert('two images rendered as <img>, not as chips', imgs.length === 2, )
  const r2img = imgs.find((i) => (i.getAttribute('src') || '').startsWith('https://fake-r2'))
  assert('the R2-backed image uses the PRESIGNED url directly', !!r2img)
  assert('  …and it carries an expiry', /X-Amz-Expires=\d+/.test(r2img?.getAttribute('src') || ''))
  const blobImg = imgs.find((i) => (i.getAttribute('src') || '').startsWith('blob:'))
  assert('the inline-stored image resolved to a BLOB url', !!blobImg)
  assert('  …meaning it was fetched through the authenticated endpoint',
    calls.some((c) => c.method === 'GET' && c.url === '/chat/attachments/12' && c.config?.responseType === 'blob'))
  assert('alt text is the filename', imgs.every((i) => !!i.getAttribute('alt')))

  say('\n  NON-IMAGES ARE DOWNLOAD CHIPS')
  assert('the PDFs did NOT render as <img>',
    !imgs.some((i) => /contract\.pdf|invoice/.test(i.getAttribute('alt') || '')))
  assert('contract.pdf renders as a chip with its name', /contract\.pdf/.test(d()))
  assert('the attachment-only message still shows its file', /invoice archive\.pdf/.test(d()))
  assert('file sizes are humanised, not raw bytes', /89 KB/.test(d()) && !/91234/.test(d()))
  const pdfLink = [...host.querySelectorAll('a')].find((a) => /contract\.pdf/.test(textOf(a)))
  assert('the R2 pdf chip links straight at the bucket',
    (pdfLink?.getAttribute('href') || '').startsWith('https://fake-r2'))
  assert('  …and opens in a new tab safely', pdfLink?.getAttribute('rel') === 'noopener noreferrer')

  say('\n  NO SESSION TOKEN IN ANY URL')
  // The whole reason routes/chat.js presigns instead of accepting ?token=.
  const urls = [...host.querySelectorAll('[src],[href]')]
    .map((n) => n.getAttribute('src') || n.getAttribute('href') || '')
  assert('no src/href contains the session token', urls.every((u) => !u.includes('SESSION-TOKEN-MUST-NOT-LEAK')))
  assert('no src/href carries a ?token= at all', urls.every((u) => !/[?&]token=/.test(u)))
  assert('  (and there were urls to check)', urls.length >= 3)

  say('\n  BOT MESSAGES')
  assert('a system message renders its text', /approved/.test(d()) && /Spotify Ads/.test(d()))
  assert('it is labelled as the bot, not a person', /market.st/.test(d()) && /Bot/.test(d()))
  assert('  and carries no author name', !/null/.test(d()))
  // *asterisks* must become real <strong>, not literal asterisks on screen.
  const strongs = [...host.querySelectorAll('strong')].map(textOf)
  assert('*asterisks* render as bold', strongs.includes('John') && strongs.includes('Spotify Ads'))
  assert('  and the asterisks themselves are gone', !/\*John\*/.test(d()))
  const viewLink = [...host.querySelectorAll('a')].find((a) => /^View/.test(textOf(a)))
  assert('a "View →" link renders from meta.link', !!viewLink)
  assert('  it points at the record', viewLink?.getAttribute('href') === '/bk/ledger?entry=41')
  assert('  it is an in-app route, not an external url', !/^https?:/.test(viewLink?.getAttribute('href') || ''))
  assert('a bot message with no link renders NO View affordance',
    [...host.querySelectorAll('a')].filter((a) => /^View/.test(textOf(a))).length === 1)
  // A bot message is not editable — there is no author to be.
  // Scoped to the message ROW, not any ancestor div that happens to contain the
  // text — an outer container holds every other message's buttons too, and the
  // assertion passes or fails on those instead.
  const botRow = [...host.querySelectorAll('div')]
    .filter((n) => (n.className || '').includes('group/msg'))
    .find((n) => /A vendor submitted an invoice/.test(textOf(n)))
  assert('a bot message offers no Edit action',
    !botRow || ![...botRow.querySelectorAll('button')].some((b) => b.getAttribute('title') === 'Edit message'))

  say('\n  THE COMPOSER CAN ATTACH')
  const fileInput = host.querySelector('input[type="file"]')
  assert('a hidden multiple file input exists', !!fileInput && fileInput.hasAttribute('multiple'))
  assert('  it is hidden behind the paperclip', (fileInput?.className || '').includes('hidden'))
  const clip = [...host.querySelectorAll('button')].find((b) => b.getAttribute('title') === 'Attach a file')
  assert('the paperclip button is present', !!clip)

  // Selecting a file must show it in the tray and enable Send even with no text.
  const send = [...host.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '').startsWith('Send'))
  assert('Send is disabled with an empty composer', !!send && send.disabled)
  const f = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'dropped.png', { type: 'image/png' })
  Object.defineProperty(fileInput, 'files', { value: [f], configurable: true })
  fileInput.dispatchEvent(new Event('change', { bubbles: true }))
  await sleep(250)
  assert('the picked file appears in the tray', /dropped\.png/.test(d()))
  const send2 = [...host.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '').startsWith('Send'))
  assert('Send is now enabled with NO text typed (attachment-only)', !!send2 && !send2.disabled)

  // And the send must go out as multipart, not JSON.
  const before = calls.filter((c) => c.method === 'POST').length
  send2.click()
  await sleep(350)
  // The SEND specifically — a mark-read POST fires right after it (the new
  // message moves `newestId`), so the last POST is not the one under test.
  const posted = calls.filter((c) => c.method === 'POST' && /\/messages$/.test(c.url)).pop()
  assert('it posted to the send endpoint', posted?.url === '/chat/channels/1/messages')
  assert('the body is FormData (multipart), not JSON', typeof FormData !== 'undefined' && posted?.body instanceof FormData)
  assert('  the file rode along', posted?.body instanceof FormData && posted.body.getAll('files').length === 1)
  assert('  Content-Type is left to the browser for the boundary',
    posted?.config?.headers && 'Content-Type' in posted.config.headers && posted.config.headers['Content-Type'] === undefined)
  assert('  (a POST was actually made)', calls.filter((c) => c.method === 'POST').length > before)

  say('\nDONE')
  globalThis.__DONE__ = true
}

main().catch((e) => { say('HARNESS THREW: ' + e.message); say(e.stack); say('\nDONE'); globalThis.__DONE__ = true })
