#!/usr/bin/env node
// Every page tour's anchors, on the REAL pages, against an EMPTY label. See anchors-dom-entry.jsx.
//     cd client && npm run anchors-dom
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const JSDOM_PATH = process.env.JSDOM_PATH || 'file:///tmp/domtest/node_modules/jsdom/lib/api.js'
if (!existsSync(fileURLToPath(JSDOM_PATH))) { console.error(`no jsdom at ${JSDOM_PATH}`); process.exit(2) }
execFileSync('npx', ['vite', 'build', '-c', 'scripts/mywork-dom.vite.config.mjs'], {
  cwd: CLIENT, env: { ...process.env, ENTRY: 'scripts/anchors-dom-entry.jsx', API_STUB: 'scripts/anchors-api-stub.js', AUTH_STUB: 'scripts/home-dom-auth-stub.js' }, stdio: ['ignore', 'ignore', 'pipe'],
})
let log = ''
try {
  log = execFileSync('node', ['scripts/mywork-dom-check.mjs', '.domsmoke/out/anchors-dom-entry.js'], {
    cwd: CLIENT, env: { ...process.env, JSDOM_PATH, WAIT_FOR_DONE: '1', WAIT_MS: '90000', PAGE_URL: 'http://localhost/' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
} catch (err) { log = (err.stdout || '') + (err.stderr || '') }
log = log.split('\n').filter((l) => !/Future Flag Warning/.test(l)).join('\n')
console.log(log.trim())
const bad = log.split('\n').filter((l) => /-> false\b/.test(l))
console.log('\n' + '─'.repeat(60))
if (bad.length || !/\bDONE\b/.test(log)) { console.log('FAILED:'); for (const b of bad) console.log('  ' + b.trim()); if (!/\bDONE\b/.test(log)) console.log('  did not reach DONE'); process.exit(1) }
console.log(`all ${log.split('\n').filter((l) => /-> true\b/.test(l)).length} assertions passed`)
