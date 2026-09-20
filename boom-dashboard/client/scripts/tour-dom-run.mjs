#!/usr/bin/env node
/**
 * The tour engine, driven under jsdom. See tour-dom-entry.jsx.
 *
 *     mkdir -p /tmp/domtest && cd /tmp/domtest && npm init -y && npm i jsdom
 *     cd client && npm run tour-dom
 *
 * Fully stubbed. Scenarios: fresh · done.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const JSDOM_PATH = process.env.JSDOM_PATH || 'file:///tmp/domtest/node_modules/jsdom/lib/api.js'
if (!existsSync(fileURLToPath(JSDOM_PATH))) { console.error(`no jsdom at ${JSDOM_PATH}`); process.exit(2) }
execFileSync('npx', ['vite', 'build', '-c', 'scripts/mywork-dom.vite.config.mjs'], {
  cwd: CLIENT, env: { ...process.env, ENTRY: 'scripts/tour-dom-entry.jsx', API_STUB: 'scripts/tour-api-stub.js', AUTH_STUB: 'scripts/home-dom-auth-stub.js' }, stdio: ['ignore', 'ignore', 'pipe'],
})
const scenarios = process.env.TOUR_SCENARIO ? [process.env.TOUR_SCENARIO] : ['fresh', 'done', 'user', 'mobile']
let all = ''
for (const sc of scenarios) {
  let log = ''
  try {
    log = execFileSync('node', ['scripts/mywork-dom-check.mjs', '.domsmoke/out/tour-dom-entry.js'], {
      cwd: CLIENT, env: { ...process.env, JSDOM_PATH, WAIT_FOR_DONE: '1', WAIT_MS: '30000', PAGE_URL: 'http://localhost/', TOUR_SCENARIO: sc },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) { log = (err.stdout || '') + (err.stderr || '') }
  log = log.split('\n').filter((l) => !/Future Flag Warning/.test(l)).join('\n')
  console.log(log.trim()); all += log + '\n'
}
const bad = all.split('\n').filter((l) => /-> false\b/.test(l))
const done = (all.match(/\bDONE\b/g) || []).length
console.log('\n' + '─'.repeat(60))
if (bad.length || done !== scenarios.length) {
  console.log('FAILED:'); for (const b of bad) console.log('  ' + b.trim())
  if (done !== scenarios.length) console.log(`  ${done} of ${scenarios.length} scenarios reached DONE`)
  process.exit(1)
}
console.log(`all ${all.split('\n').filter((l) => /-> true\b/.test(l)).length} assertions passed across ${scenarios.length} scenarios`)
