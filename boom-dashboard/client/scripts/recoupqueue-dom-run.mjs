#!/usr/bin/env node
/**
 * Does the recoupments upload queue render, and does its partition hold?
 *
 * See scripts/recoupqueue-dom-entry.jsx for why `npm run smoke` cannot answer
 * either: it renders under renderToString where effects never fire, so
 * Recoupments only ever draws its loading skeleton and reports "ok" for a queue
 * that drew nothing. Every figure and every partition is behind /bk/entries.
 *
 * ── Setup (once) ──
 *     mkdir -p /tmp/domtest && cd /tmp/domtest && npm init -y && npm i jsdom
 *     cd client && npm run recoupqueue-dom
 * If jsdom lives elsewhere, pass JSDOM_PATH=file:///abs/path/to/jsdom/lib/api.js.
 *
 * Fully stubbed (scripts/recoupqueue-api-stub.js) — no server, no database. The
 * fixture carries one artist per band because the thing under test is the
 * PARTITION, and live data cannot pin it: every one of the 152 live artists has
 * something pending, and which band an artist sits in moves every time a
 * statement is uploaded.
 *
 * ── Verified to bite ──
 * Reinstating the old `pending > 0` test for "can upload" — the shape that made
 * 152 artist cards unrankable, since all 152 have something pending — turns
 * seven assertions red, including "the queue holds exactly the 3 uploadable
 * artists". Rendering the folded sections open (which is what the `collapsed`
 * Set does by default, and how they first shipped) turns five red.
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
  env: { ...process.env, ENTRY: 'scripts/recoupqueue-dom-entry.jsx', API_STUB: 'scripts/recoupqueue-api-stub.js' },
  stdio: ['ignore', 'ignore', 'pipe'],
})

let log = ''
try {
  log = execFileSync('node', ['scripts/mywork-dom-check.mjs', '.domsmoke/out/recoupqueue-dom-entry.js'], {
    cwd: CLIENT,
    env: { ...process.env, JSDOM_PATH, WAIT_FOR_DONE: '1', WAIT_MS: '40000', PAGE_URL: 'http://localhost/recoupments' },
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
