#!/usr/bin/env node
/**
 * Does the artist budget GRID work — the cells, the keyboard, the paste, the
 * filter and the totals row that has to follow it?
 *
 * See scripts/budgetsheet-dom-entry.jsx for why `npm run smoke` cannot answer
 * any of that: it renders under renderToString where effects never fire, so the
 * page draws its loading skeleton, reports "ok" and has rendered no grid at all.
 *
 * ── Setup ──
 *     mkdir -p /tmp/domtest && cd /tmp/domtest && npm init -y && npm i jsdom
 *     cd client && npm run budgetsheet-dom
 *
 * Fully stubbed (scripts/budgetsheet-api-stub.js) — no server, no database. The
 * fixture's numbers are picked so a wrong answer is a DIFFERENT number rather
 * than a coincidentally equal one; that reasoning is in the stub's header.
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
  env: {
    ...process.env,
    ENTRY: 'scripts/budgetsheet-dom-entry.jsx',
    API_STUB: 'scripts/budgetsheet-api-stub.js',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
})

let log = ''
try {
  log = execFileSync('node', ['scripts/mywork-dom-check.mjs', '.domsmoke/out/budgetsheet-dom-entry.js'], {
    cwd: CLIENT,
    env: { ...process.env, JSDOM_PATH, WAIT_FOR_DONE: '1', WAIT_MS: '30000',
      PAGE_URL: 'http://localhost/artist-budgets/demoartist' },
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
