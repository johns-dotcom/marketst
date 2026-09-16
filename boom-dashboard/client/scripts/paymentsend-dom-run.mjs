#!/usr/bin/env node
/**
 * Builds and runs the payment-confirmation race harness, and grades it.
 *
 * See scripts/paymentsend-dom-entry.jsx for what it reproduces. Everything is
 * stubbed at the api boundary — no server, no database, no email.
 *
 *     cd client && npm run paymentsend-dom
 *
 * jsdom is not a dependency: `mkdir -p /tmp/domtest && cd /tmp/domtest &&
 * npm init -y && npm i jsdom`, or point JSDOM_PATH at an existing copy.
 *
 * A run takes ~15s and that is the test, not slack: it waits out the page's own
 * 4-second post-upload refetch rather than shortening it.
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
  env: { ...process.env, ENTRY: 'scripts/paymentsend-dom-entry.jsx', API_STUB: 'scripts/paymentsend-api-stub.js' },
  stdio: ['ignore', 'ignore', 'inherit'],
})

const SENTINELS = {
  race: /RESULT: /,
  split: /SPLIT: the dialog closed/,
  partial: /PARTIAL: and quotes both figures/,
  duedate: /DUE: and the cell went back/,
  'duedate-family': /DUE: and the cell went back/,
  detail: /CONFLICT: the row was NOT overwritten/,
  queue: /QUEUE: done/,
}

const SCENARIOS = process.argv.slice(2).length ? process.argv.slice(2) : ['race', 'split', 'partial', 'duedate', 'duedate-family', 'detail', 'queue']
const failures = []
for (const scenario of SCENARIOS) {
let log = ''
try {
  log = execFileSync('node', ['scripts/mywork-dom-check.mjs', '.domsmoke/out/paymentsend-dom-entry.js'], {
    cwd: CLIENT,
    env: {
      ...process.env,
      SCENARIO: scenario,
      // The partial-family fixture is a different response from the same stub.
      PARTIAL: scenario === 'partial' ? '1' : '',
      FAMILY: scenario === 'duedate-family' ? '1' : '',
      // The queue fixture: seven rows spanning every priority band, one
      // vendor holding three of them.
      QUEUE: scenario === 'queue' ? '1' : '',
      JSDOM_PATH,
      WAIT_FOR_DONE: '1',
      WAIT_MS: '60000',
      PAGE_URL: 'http://localhost/bk/payments',
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
} catch (err) {
  log = (err.stdout || '') + (err.stderr || '')
}
log = log.split('\n').filter((l) => !/Future Flag Warning/.test(l)).join('\n')
console.log(`\n── ${scenario} ──`)
console.log(log.trim())

  const found = log.split('\n').filter((l) => /-> false/.test(l))
  // The scenario has to have actually RUN. Every assertion reads `-> false`
  // when the page fails to render, but a log that stops early has no `-> false`
  // in it at all and would otherwise grade as a pass.
  if (!SENTINELS[scenario] || !SENTINELS[scenario].test(log)) {
    found.push(`the ${scenario} scenario never reached its last check`)
  }
  for (const f of found) failures.push(`${scenario}: ${f.trim()}`)
}

console.log('\n' + '─'.repeat(60))
console.log(failures.length ? `FAIL (${failures.length})` : 'ok — a sent confirmation stays sent, and payments can be split')
for (const f of failures) console.log('  ' + f)
process.exit(failures.length ? 1 : 0)
