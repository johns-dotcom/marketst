/**
 * The autosave must never write one task's text onto another.
 *
 * No React here — the hook's logic lives in refs and plain functions precisely
 * so it can be exercised directly. The hook wrapper is three lines of useEffect
 * around this; the part that can lose John's writing is what gets tested.
 */
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'fs'

// Re-implementing the hook's body would test the replica, so the real module is
// loaded with a minimal React shim — useRef/useEffect/useCallback are all this
// file uses and all three are trivial outside a render loop.
const SRC = fileURLToPath(new URL('../src/components/mywork/useAutosave.js', import.meta.url))
const teardowns = []
const shim = `
  const useRef = (v) => ({ current: v })
  const useEffect = (fn) => { const t = fn(); if (typeof t === 'function') globalThis.__teardowns.push(t) }
  const useCallback = (fn) => fn
`
globalThis.__teardowns = teardowns
const body = readFileSync(SRC, 'utf8').replace(/^import .*$/m, shim)
const mod = await import('data:text/javascript;base64,' + Buffer.from(body).toString('base64'))
const useAutosave = mod.default

let pass = 0, fail = 0
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A recording fake server.
const writes = []
const server = { 1: { notes: 'A original' }, 2: { notes: 'B original' } }
const save = async (id, patch) => { writes.push({ id, ...patch }); Object.assign(server[id], patch) }

const a = useAutosave(save, { delay: 60 })
a.prime(1, { notes: 'A original' })
a.prime(2, { notes: 'B original' })

console.log('1. the write lands on the task that was being typed into')
// Type into 1, then "switch" to 2 and type there, all inside the debounce.
a.change(1, 'notes', 'A edited')
await sleep(10)
a.change(2, 'notes', 'B edited')
await sleep(200)
ok(server[1].notes === 'A edited', `task 1 kept its own text (${JSON.stringify(server[1].notes)})`)
ok(server[2].notes === 'B edited', `task 2 kept its own text (${JSON.stringify(server[2].notes)})`)
ok(writes.filter((w) => w.id === 1).length === 1 && writes.filter((w) => w.id === 2).length === 1,
   `one write each, not one clobbering the other (${writes.length} total)`)

console.log('\n2. an explicit flush on selection change writes immediately')
writes.length = 0
a.change(1, 'notes', 'flushed right away')
ok(a.hasPending(), 'a pending write exists before the flush')
await a.flush()
ok(server[1].notes === 'flushed right away', 'and the flush wrote it without waiting for the timer')
ok(!a.hasPending(), 'nothing left pending afterwards')

console.log('\n3. typing does not spam the server')
writes.length = 0
const word = 'reconciliation'
for (const ch of word) { a.change(1, 'notes', (server[1].notes + ch)); await sleep(3) }
await sleep(200)
ok(writes.length === 1, `${word.length} keystrokes produced ${writes.length} request`)

console.log('\n4. mount does not overwrite a real body with an empty one')
writes.length = 0
a.prime(3, { notes: 'something already written' })
server[3] = { notes: 'something already written' }
a.change(3, 'notes', 'something already written')   // the controlled-input echo
await sleep(200)
ok(writes.length === 0, 'setting the field to what the server already has writes nothing')
ok(server[3].notes === 'something already written', 'and the body is intact')

console.log('\n5. typing back to the original cancels the pending write')
writes.length = 0
a.change(3, 'notes', 'something already written!!')
a.change(3, 'notes', 'something already written')
await sleep(200)
ok(writes.length === 0, 'an edit undone before the debounce sends nothing')

console.log('\n6. a failed write is retried, not lost')
writes.length = 0
let failNext = true
const flaky = async (id, patch) => {
  if (failNext) { failNext = false; throw new Error('network') }
  writes.push({ id, ...patch }); Object.assign(server[id], patch)
}
const b = useAutosave(flaky, { delay: 30 })
b.prime(1, { notes: server[1].notes })
b.change(1, 'notes', 'survives a failure')
await sleep(120)
ok(writes.length === 0 && b.hasPending(), 'the failed write is still pending, not dropped')
await b.flush()
ok(server[1].notes === 'survives a failure', `and the retry lands it (${JSON.stringify(server[1].notes)})`)

console.log('\n7. two fields on one task are one request')
writes.length = 0
a.prime(2, { notes: server[2].notes, description: 'title' })
a.change(2, 'notes', 'new body')
a.change(2, 'description', 'new title')
await sleep(200)
ok(writes.length === 1, `two fields, ${writes.length} request`)
ok(writes[0].notes === 'new body' && writes[0].description === 'new title', 'carrying both changes')

console.log('\n8. unmounting flushes what is pending')
writes.length = 0
a.change(1, 'notes', 'typed then navigated away')
for (const t of teardowns) t()
await sleep(120)
ok(server[1].notes === 'typed then navigated away',
   `leaving the page mid-sentence keeps the sentence (${JSON.stringify(server[1].notes)})`)

console.log(fail ? `\n${fail} FAILED` : `\n${pass} passed, 0 failed`)
process.exit(fail ? 1 : 0)
