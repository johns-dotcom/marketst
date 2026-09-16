#!/usr/bin/env node
/**
 * Builds and runs the ledger vendor-columns harness, and grades it.
 *
 * See scripts/ledgervendor-dom-entry.jsx for what it checks. Everything is
 * stubbed at the api boundary — no server, no database.
 *
 *     cd client && npm run ledgervendor-dom
 *
 * jsdom is not a dependency: `mkdir -p /tmp/domtest && cd /tmp/domtest &&
 * npm init -y && npm i jsdom`, or point JSDOM_PATH at an existing copy.
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
  env: { ...process.env, ENTRY: 'scripts/ledgervendor-dom-entry.jsx', API_STUB: 'scripts/ledgervendor-api-stub.js' },
  stdio: ['ignore', 'ignore', 'inherit'],
})

const SENTINELS = {
  columns: /BULK: turning the column back off/,
  split: /SPLIT: two slices, adding to the family total/,
}

const SCENARIOS = process.argv.slice(2).length ? process.argv.slice(2) : ['columns', 'split']
const failures = []
for (const scenario of SCENARIOS) {
let log = ''
try {
  log = execFileSync('node', ['scripts/mywork-dom-check.mjs', '.domsmoke/out/ledgervendor-dom-entry.js'], {
    cwd: CLIENT,
    env: {
      ...process.env,
      SCENARIO: scenario,
      JSDOM_PATH,
      WAIT_FOR_DONE: '1',
      WAIT_MS: '40000',
      PAGE_URL: 'http://localhost/bk/ledger',
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
console.log(failures.length ? `FAIL (${failures.length})` : 'ok — vendor-form columns, Bulk said once, and the shared split dialog')
for (const f of failures) console.log('  ' + f)
process.exit(failures.length ? 1 : 0)
