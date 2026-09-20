#!/usr/bin/env node
/**
 * Run every vendor-form DOM scenario against BOTH pages and fail on a `-> false`.
 *
 * ── Why this wrapper exists ──
 * The scenarios print assertions; nothing was reading them. A check whose result
 * a human has to eyeball is a check that goes green the day nobody looks — so
 * this greps its own output for `-> false` and exits non-zero. The individual
 * scenario is still runnable by hand when one of them fails and you want to see
 * the whole transcript.
 *
 *     npm run vendorform-dom          # builds, then runs all 8 combinations
 *
 * jsdom is NOT a dependency — it is a large tree and this is an occasional
 * diagnostic. Install it anywhere and point JSDOM_PATH at it:
 *
 *     mkdir -p /tmp/domtest && cd /tmp/domtest && npm init -y && npm i jsdom
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const DEFAULT_JSDOM = '/tmp/domtest/node_modules/jsdom/lib/api.js'
const jsdom = process.env.JSDOM_PATH
  || (existsSync(DEFAULT_JSDOM) ? `file://${DEFAULT_JSDOM}` : null)
if (!jsdom) {
  console.error('jsdom not found. Install it and set JSDOM_PATH — see this file\'s header.')
  process.exit(2)
}

const BUNDLE = '.domsmoke/out/vendorform-dom-entry.js'
const SCENARIOS = ['ach', 'wire', 'wiredom', 'paypal', 'files', 'multi', 'backnext', 'enter', 'remove']
const SCENARIO_ENV = { backnext: { PARSE: '1' }, remove: { SLOWSCAN: '1' } }
const PAGES = ['live', 'lab']

let failed = 0
for (const page of PAGES) {
  for (const scenario of SCENARIOS) {
    const r = spawnSync(process.execPath, ['scripts/mywork-dom-check.mjs', BUNDLE], {
      encoding: 'utf8',
      env: { ...process.env, ...(SCENARIO_ENV[scenario] || {}), SCENARIO: scenario, PAGE: page === 'lab' ? 'lab' : '', JSDOM_PATH: jsdom },
    })
    const out = (r.stdout || '') + (r.stderr || '')
    // An assertion line is `label -> true`. Anything false, anything thrown, and
    // a run that produced no assertions at all (the page never mounted) all fail.
    const asserts = out.split('\n').filter((l) => / -> (true|false)$/.test(l.trim()))
    const bad = asserts.filter((l) => l.trim().endsWith('-> false'))
    const threw = /THROWN:|window\.error:/.test(out)
    const ok = asserts.length > 0 && !bad.length && !threw
    if (!ok) failed += 1
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${page.padEnd(4)} ${scenario.padEnd(6)} ${asserts.length} assertions`)
    if (!ok) {
      for (const l of bad) console.log('        ' + l.trim())
      if (threw) for (const l of out.split('\n').filter((x) => /THROWN:|window\.error:/.test(x))) console.log('        ' + l.trim())
      if (!asserts.length) console.log('        no assertions produced — the page did not mount')
    }
  }
}
console.log(failed ? `\n${failed} scenario(s) failed` : '\nall vendor-form DOM scenarios passed')
process.exit(failed ? 1 : 0)
