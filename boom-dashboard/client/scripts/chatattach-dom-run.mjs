#!/usr/bin/env node
/**
 * Do chat attachments render, and does the no-token-in-a-URL rule hold?
 *
 * See scripts/chatattach-dom-entry.jsx for why `npm run smoke` cannot answer
 * either: it renders under renderToString where effects never fire, so Messages
 * only ever draws its loading skeleton and reports "ok" for a page that rendered
 * no messages at all. Every attachment is behind /chat/channels/:id/messages.
 *
 * ── Setup (once) ──
 *     mkdir -p /tmp/domtest && cd /tmp/domtest && npm init -y && npm i jsdom
 *     cd client && npm run chatattach-dom
 * If jsdom lives elsewhere, pass JSDOM_PATH=file:///abs/path/to/jsdom/lib/api.js.
 *
 * Fully stubbed (scripts/chatattach-api-stub.js) — no server, no database. The
 * fixture pins one of each storage shape because the thing under test is which
 * RENDER BRANCH each takes, and live data cannot pin that: whether an
 * attachment is R2-backed or inline depends on how the server was configured
 * the moment it was uploaded.
 *
 * ── Verified to bite ──
 * Putting the session token back in an image URL — the `?token=` shape
 * authMiddleware still accepts, and the obvious way to make an <img> load from
 * an authenticated endpoint — turns THREE assertions red here.
 *
 * What this harness does NOT cover: it stubs the API, so it cannot see a server
 * that forgets to presign. That bug is real (the message-LIST query didn't sign
 * attachments while only the socket payload did, so every image broke on
 * reload) and it was caught against a running server instead — the fixture here
 * hands the client a url because the point is what the client DOES with one.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const JSDOM_PATH = process.env.JSDOM_PATH || 'file:///tmp/domtest/node_modules/jsdom/lib/api.js'
if (!existsSync(fileURLToPath(JSDOM_PATH))) {
  console.error(`no jsdom at ${JSDOM_PATH} — see the header of this file`)
  process.exit(2)
}

execFileSync('npx', ['vite', 'build', '-c', 'scripts/mywork-dom.vite.config.mjs'], {
  cwd: CLIENT,
  env: { ...process.env, ENTRY: 'scripts/chatattach-dom-entry.jsx', API_STUB: 'scripts/chatattach-api-stub.js' },
  stdio: ['ignore', 'ignore', 'pipe'],
})

let log = ''
try {
  log = execFileSync('node', ['scripts/mywork-dom-check.mjs', '.domsmoke/out/chatattach-dom-entry.js'], {
    cwd: CLIENT,
    env: { ...process.env, JSDOM_PATH, WAIT_FOR_DONE: '1', WAIT_MS: '40000', PAGE_URL: 'http://localhost/messages/1' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
} catch (err) {
  log = (err.stdout || '') + (err.stderr || '')
}
log = log.split('\n').filter((l) => !/Future Flag Warning/.test(l)).join('\n')
console.log(log.trim())

// Grep our own output — an assertion that prints `-> false` and exits 0 is a
// green run nobody reads.
const bad = log.split('\n').filter((l) => /-> false\b/.test(l))
console.log('\n' + '─'.repeat(60))
if (bad.length || !/\bDONE\b/.test(log)) {
  console.log('FAILED:')
  for (const b of bad) console.log('  ' + b.trim())
  if (!/\bDONE\b/.test(log)) console.log('  harness never reached DONE')
  process.exit(1)
}
console.log(`all ${log.split('\n').filter((l) => /-> true\b/.test(l)).length} assertions passed`)
