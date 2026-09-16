// Render the ad-allocation components against a REAL /ad-charges payload.
//
// ── Why this exists on top of `npm run smoke` ──
// smoke renders a PAGE, and effects never fire under renderToString, so the page
// renders in its LOADING state and every data-bearing branch goes unexecuted. That
// gap has cost this repo a white page more than once (a `taskOrder` that does not
// exist; a `const` read above its own declaration). This runs the branches, with
// data the server actually produced — and it earned its place: on the first run it
// found two live bugs that `vite build` and `npm run smoke` both passed.
//
//   1. charges sorted by String(pgDate) — "Tue May 04 …" — so the greedy draw
//      compared WEEKDAY NAMES and consumed the 10th before the 4th.
//   2. a fully-allocated charge left the label-level bucket and so vanished from
//      the page, taking its allocation out of the month's total.
//
// ── Running it (two steps, because the payload must be real) ──
//   cd server && PORT=3011 node index.js &
//   cd server && NODE_PATH=$PWD/node_modules node scripts/ad-payload-capture.cjs \
//                  ../client/.adsmoke/payload.json
//   cd client && npx vite build --ssr scripts/adalloc-render-check.jsx \
//                  --outDir .adsmoke/out --emptyOutDir && node .adsmoke/out/*.js
//
// The capture script seeds a far-future month in the DEV database, fetches the
// real endpoints, and deletes everything it made.
import React from 'react'
import { renderToString } from 'react-dom/server'
import payload from '../.adsmoke/payload.json'
import ChargeTable from '../src/components/adalloc/ChargeTable'
import AllocatePanel from '../src/components/adalloc/AllocatePanel'
import ImportMapper from '../src/components/adalloc/ImportMapper'

let pass = 0, fail = 0
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`) }
const { data, plan } = payload

ok(data.charges.length >= 2, `${data.charges.length} real charges in the payload`)
ok(data.charges.some((c) => c.allocations.length > 0), 'one of them carries a real allocation')

const t = renderToString(React.createElement(ChargeTable, {
  charges: data.charges, highlight: plan.per_charge.map((c) => c.root_id), onUndo: () => {},
}))
ok(t.length > 800, `ChargeTable rendered its rows (${t.length} bytes)`)
ok(t.includes(data.charges[0].payee), 'the payee is on screen')
const alloc = data.charges.flatMap((c) => c.allocations)[0]
ok(!!alloc && t.includes(alloc.artist), 'the allocation chip names the artist')
ok(t.includes('$'), 'money is formatted')
ok(!/undefined|NaN|Invalid Date/.test(t), 'no undefined / NaN / Invalid Date anywhere in the markup')

const a = renderToString(React.createElement(AllocatePanel, {
  campaigns: data.campaigns, openDollars: data.allocatable_cents / 100,
  preview: plan, busy: false, error: '',
}))
ok(a.includes('drawn from'), 'AllocatePanel ran its preview branch')
ok(a.includes(String(data.campaigns[0].name)), 'and lists a real campaign')
ok(!/undefined|NaN|Invalid Date/.test(a), 'no undefined / NaN / Invalid Date in the preview')

const im = renderToString(React.createElement(ImportMapper, {
  campaigns: data.campaigns, platform: 'Facebook', busy: false,
}))
ok(im.includes('Drop a CSV'), 'ImportMapper renders its drop zone')

// Every field the page and components read must be a field the server sends.
// This is the `taskOrder` class of bug: an identifier that exists in the code and
// nowhere in the data.
const need = {
  'data': ['charges', 'campaigns', 'allocatable_cents', 'allocated_cents', 'open_cents', 'open_usd', 'pool_usd'],
  'plan': ['per_campaign', 'per_charge', 'total', 'open_before', 'open_after'],
}
for (const [obj, keys] of Object.entries(need)) {
  const src = obj === 'data' ? data : plan
  const missing = keys.filter((k) => !(k in src))
  ok(missing.length === 0, `${obj}: every field read exists${missing.length ? ` — MISSING ${missing.join(', ')}` : ''}`)
}
for (const [label, row, keys] of [
  ['charge', data.charges[0], ['root_id', 'date', 'payee', 'category', 'charge_cents', 'open_cents', 'allocations', 'attributed', 'allocatable', 'blocked']],
  ['campaign', data.campaigns[0], ['id', 'name', 'platform', 'artist', 'song', 'total_budget', 'allocated_cents']],
  ['per_charge', plan.per_charge[0], ['root_id', 'date', 'payee', 'charge', 'allocating', 'open_after', 'whole_charge']],
  ['per_campaign', plan.per_campaign[0], ['campaign_id', 'campaign_name', 'artist', 'song', 'amount', 'charges']],
  ['allocation', data.charges.flatMap((c) => c.allocations)[0], ['expense_id', 'campaign_id', 'campaign_name', 'artist', 'song', 'cents']],
]) {
  const missing = keys.filter((k) => !row || !(k in row))
  ok(missing.length === 0, `${label} row: every field read exists${missing.length ? ` — MISSING ${missing.join(', ')}` : ''}`)
}
console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
