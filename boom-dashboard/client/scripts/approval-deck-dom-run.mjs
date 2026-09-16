#!/usr/bin/env node
/**
 * The Approvals checklist deck, in a real DOM.
 *
 * The harness (`approval-deck-dom-entry.jsx`) predates this runner and was
 * driven by hand with a SCENARIO env var — which means it was only ever run by
 * whoever had just written it. A check nobody runs is a check that goes green
 * the day it stops working, so the four scenarios are one command now.
 *
 *   socials   handles are editable and addable, and a row's `artist`/`amount`
 *             survive an edit to its handle
 *   split     a split invoice SAYS it is split (the confirmations show the
 *             parent's single artist and the full amount)
 *   splitbad  slices that do not sum to the invoice are called out
 *   artist    Correct artist? is a typable picker over the roster + the ledger,
 *             it writes the CANONICAL spelling, and it still takes a name
 *             nobody has heard of
 *
 * `npm run smoke` covers none of it: the deck is a modal that only mounts once
 * somebody opens it with items, so BkApprovals renders green with every line of
 * this component unexecuted.
 *
 * ── Setup ──
 *     mkdir -p /tmp/domtest && cd /tmp/domtest && npm init -y && npm i jsdom
 *     cd client && npm run approval-dom
 *
 * Fully stubbed (scripts/approval-deck-api-stub.js) — no server, no database.
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
  env: { ...process.env, ENTRY: 'scripts/approval-deck-dom-entry.jsx', API_STUB: 'scripts/approval-deck-api-stub.js' },
  stdio: ['ignore', 'ignore', 'pipe'],
})

const SCENARIOS = process.env.SCENARIO ? [process.env.SCENARIO] : ['socials', 'split', 'splitbad', 'artist']
let failed = 0

for (const scenario of SCENARIOS) {
  let log = ''
  try {
    log = execFileSync('node', ['scripts/mywork-dom-check.mjs', '.domsmoke/out/approval-deck-dom-entry.js'], {
      cwd: CLIENT,
      env: { ...process.env, JSDOM_PATH, SCENARIO: scenario, WAIT_MS: '9000', PAGE_URL: 'http://localhost/bk/approvals' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    // A spawn that never started has NULL stdout, so without this the log is
    // empty and every assertion below passes vacuously — which is exactly what
    // happened the first time this ran (`SCENARIO` vs `scenario`): four empty
    // scenarios reported ok.
    log = (err.stdout || '') + (err.stderr || '')
    if (!log) log = `harness did not run: ${err.message}`
  }
  log = log.split('\n').filter((l) => !/Future Flag Warning/.test(l)).join('\n')
  console.log(`\n── ${scenario} ${'─'.repeat(Math.max(0, 56 - scenario.length))}`)
  console.log(log.trim())

  // Grep our own output, the same way the other runners do. Note the older
  // scenarios print counts and objects rather than booleans, so this catches an
  // explicit false and nothing weaker — which is what they were written to
  // report. The `artist` scenario is booleans throughout, deliberately.
  const bad = log.split('\n').filter((l) => /-> false\b/.test(l))
  const threw = /--- errors ---/.test(log)
  // NO ASSERTIONS IS A FAILURE, not a pass. A scenario that printed nothing has
  // told you nothing, and "no `-> false` in an empty string" is the shape that
  // makes a broken harness look like working code.
  const silent = !/->/.test(log)
  if (bad.length || threw || silent) {
    failed += 1
    console.log('  FAILED:')
    for (const b of bad) console.log('    ' + b.trim())
    if (threw) console.log('    the deck logged an error or threw')
    if (silent) console.log('    the scenario produced no assertions at all')
  }
}

console.log('\n' + '─'.repeat(60))
if (failed) {
  console.log(`${failed} of ${SCENARIOS.length} scenario(s) failed`)
  process.exit(1)
}
console.log(`ok — ${SCENARIOS.length} scenario(s), the checklist edits and saves what it shows`)
