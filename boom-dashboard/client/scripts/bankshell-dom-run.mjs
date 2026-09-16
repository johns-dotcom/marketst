#!/usr/bin/env node
/**
 * Does the Banking header hold the month across a tab switch?
 *
 * See scripts/bankshell-dom-entry.jsx for why neither `npm run smoke` nor the
 * two existing DOM harnesses can answer that: smoke never fires an effect, and
 * both of the others mount their page bare, with no BankShell above it.
 *
 * ── Setup ──
 *     mkdir -p /tmp/domtest && cd /tmp/domtest && npm init -y && npm i jsdom
 *     cd client && npm run bankshell-dom
 *
 * Fully stubbed (scripts/bankshell-api-stub.js) — no server, no database. That
 * is deliberate rather than lazy: half of what this asserts is a REQUEST COUNT
 * (four tabs must cost one /statements/:id, at 703KB each), and you cannot
 * count your own reads against a live server other callers are also reading.
 *
 * Verified it can fail: making the store drop its selection when the last
 * subscriber unsubscribes — component state wearing a store's clothes, which is
 * exactly the bug this change fixes — turns the two SWITCH assertions red.
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
  env: { ...process.env, ENTRY: 'scripts/bankshell-dom-entry.jsx', API_STUB: 'scripts/bankshell-api-stub.js' },
  stdio: ['ignore', 'ignore', 'pipe'],
})

let log = ''
try {
  log = execFileSync('node', ['scripts/mywork-dom-check.mjs', '.domsmoke/out/bankshell-dom-entry.js'], {
    cwd: CLIENT,
    env: { ...process.env, JSDOM_PATH, WAIT_FOR_DONE: '1', WAIT_MS: '30000', PAGE_URL: 'http://localhost/bk/bank-matching' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
} catch (err) {
  log = (err.stdout || '') + (err.stderr || '')
}
log = log.split('\n').filter((l) => !/Future Flag Warning/.test(l)).join('\n')
console.log(log.trim())

// Grep our own output, the same way the other runners do — an assertion that
// prints `-> false` and exits 0 is a green run nobody reads.
const bad = log.split('\n').filter((l) => /-> false\b/.test(l))
console.log('\n' + '─'.repeat(60))
if (bad.length || !/\bDONE\b/.test(log)) {
  console.log('FAILED:')
  for (const b of bad) console.log('  ' + b.trim())
  if (!/\bDONE\b/.test(log)) console.log('  the harness did not reach DONE')
  process.exit(1)
}
console.log('ok — one header, one month, and it survives the tab change')
