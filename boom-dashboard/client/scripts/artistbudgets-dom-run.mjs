#!/usr/bin/env node
/**
 * Do the artist budget cards render, and does the two-endpoint merge hold?
 *
 * See scripts/artistbudgets-dom-entry.jsx for why `npm run smoke` cannot answer
 * either: it renders under renderToString where effects never fire, so the page
 * only ever draws its loading branch and every figure on this page is behind a
 * fetch.
 *
 * ── Setup ──
 *     mkdir -p /tmp/domtest && cd /tmp/domtest && npm init -y && npm i jsdom
 *     cd client && npm run artistbudgets-dom
 *
 * Fully stubbed (scripts/artistbudgets-api-stub.js) — no server, no database.
 * The fixture is built so one artist appears in BOTH endpoints, one in only the
 * plan side and one in only the ledger side, because "an artist renders exactly
 * once" and "nobody vanishes" are the assertions that matter and you cannot
 * control that overlap against live data.
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
  env: { ...process.env, ENTRY: 'scripts/artistbudgets-dom-entry.jsx', API_STUB: 'scripts/artistbudgets-api-stub.js' },
  stdio: ['ignore', 'ignore', 'pipe'],
})

let log = ''
try {
  log = execFileSync('node', ['scripts/mywork-dom-check.mjs', '.domsmoke/out/artistbudgets-dom-entry.js'], {
    cwd: CLIENT,
    env: { ...process.env, JSDOM_PATH, WAIT_FOR_DONE: '1', WAIT_MS: '30000', PAGE_URL: 'http://localhost/artist-budgets' },
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
console.log('all assertions passed')
