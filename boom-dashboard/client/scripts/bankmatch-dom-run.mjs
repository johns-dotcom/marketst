#!/usr/bin/env node
/**
 * Does the recoupable answer on Bank Matching actually reach the ledger?
 *
 * ── Why a harness and not `npm run smoke` ──
 * smoke renders the page with `renderToString`, where effects never fire — so
 * Bank Matching renders in its LOADING state and every control that lives on a
 * data row goes unbuilt. It reports "ok, 686 bytes" for a page whose table never
 * drew a line. The recoupable buttons are on a transaction row and on a review
 * card, so a green smoke run says nothing at all about them.
 *
 * ── What it proves ──
 * Four surfaces, each from the click to the database row:
 *
 *   table  press "No" on an open debit, then pick a category (which IS the
 *          booking on that row). Asserts the POST body carried recoupable:false
 *          and the ledger row landed recoupable=false, recoup_reviewed=true.
 *   deck   the review card: press R twice (unanswered → yes → no) and accept.
 *   form   the ⋯ menu's "Book it myself" form: press Yes, then Book.
 *   keep   an ALREADY-BOOKED, never-answered row — the state 1,919 live rows are
 *          in. The card keeps the category, so the answer cannot ride along on a
 *          booking and has to go through /bk/recoup-review instead. That path
 *          has a gate (only a row this app booked) that could silently no-op.
 *
 * Every scenario runs against a REAL server and a REAL database, because the
 * shapes here are deep — `matched`, `suggestions`, `vendor_hint`,
 * `no_invoice_expected` — and a hand-written fixture for /statements/:id can
 * only ever confirm the guess that wrote it. The api module is swapped for a
 * proxy (scripts/bankmatch-api-stub.js) that records every call so the BODY can
 * be asserted, not just that something happened.
 *
 * ── Setup ──
 *     cd server && PORT=3011 node index.js &     # boots against the dev database
 *     mkdir -p /tmp/domtest && cd /tmp/domtest && npm init -y && npm i jsdom
 *     cd client && npm run bankmatch-dom
 *
 * jsdom is deliberately NOT a dependency — a large tree for an occasional
 * diagnostic. Point JSDOM_PATH somewhere else if /tmp/domtest is not where it
 * landed. API_BASE overrides the server.
 *
 * Fixtures are created and DELETED by this script, pass or fail — including the
 * ledger entry a scenario books and the payee/category lessons the booking
 * teaches. It prints what the ledger held before deleting it, which is the
 * assertion that matters most.
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = path.resolve(CLIENT, '../server')
// pg / dotenv / jsonwebtoken live in server/node_modules; the client has no use
// for them and adding three server dependencies to it for a diagnostic would be
// the wrong trade.
const req = createRequire(path.join(SERVER, 'index.js'))
req('dotenv').config({ path: path.join(SERVER, '.env') })
const { Pool } = req('pg')
const jwt = req('jsonwebtoken')

const API = process.env.API_BASE || 'http://127.0.0.1:3011/api'
const JSDOM_PATH = process.env.JSDOM_PATH || 'file:///tmp/domtest/node_modules/jsdom/lib/api.js'
const SCENARIOS = process.argv.slice(2).length ? process.argv.slice(2) : ['table', 'deck', 'form', 'keep']

if (!process.env.DATABASE_URL) {
  console.error('no DATABASE_URL — run from the repo so server/.env is readable')
  process.exit(2)
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const token = jwt.sign(
  { id: 1, email: 'john@deanst.co', name: 'John', role: 'Superadmin', tv: 0 },
  process.env.JWT_SECRET, { expiresIn: '1h' })

const alive = await fetch(`${API}/statements`, { headers: { authorization: `Bearer ${token}` } })
  .then((r) => r.ok).catch(() => false)
if (!alive) {
  console.error(`no server answering at ${API} — see the header of this file`)
  await pool.end()
  process.exit(2)
}

// Built ONCE: the entry reads its scenario from the environment at run time.
console.log('building the harness…')
execFileSync('npx', ['vite', 'build', '-c', 'scripts/mywork-dom.vite.config.mjs'], {
  cwd: CLIENT,
  env: { ...process.env, ENTRY: 'scripts/bankmatch-dom-entry.jsx', API_STUB: 'scripts/bankmatch-api-stub.js' },
  stdio: ['ignore', 'ignore', 'inherit'],
})
const BUNDLE = path.join(CLIENT, '.domsmoke/out/bankmatch-dom-entry.js')
if (!existsSync(BUNDLE)) { console.error('the harness did not build'); await pool.end(); process.exit(2) }

const out = []
for (const scenario of SCENARIOS) {
  const payee = `DOMCHECK ${scenario.toUpperCase()}`
  const { rows: [st] } = await pool.query(
    `INSERT INTO bank_statements (account, filename, period_start, period_end, txn_count, status, uploaded_by)
     VALUES ('bofa','DOMCHECK.pdf','2026-08-01','2026-08-31',1,'ready','domcheck') RETURNING id`)
  const { rows: [tx] } = await pool.query(
    `INSERT INTO bank_transactions (statement_id, txn_date, description, payee_guess, amount, direction, currency, dismissed)
     VALUES ($1,'2026-08-15',$2,$2,$3,'debit','USD',false) RETURNING id`, [st.id, payee, 97.31])

  // 'keep' needs the row already booked and still unanswered.
  if (scenario === 'keep') {
    await fetch(`${API}/statements/tx/${tx.id}/create-entry`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'Marketing', confirm_new: true }),
    })
  }

  console.log(`\n── ${scenario} ──  statement ${st.id}, txn ${tx.id}`)
  let log = ''
  try {
    log = execFileSync('node', ['scripts/mywork-dom-check.mjs', BUNDLE], {
      cwd: CLIENT,
      env: {
        ...process.env,
        SCENARIO: scenario,
        FIXTURE_PAYEE: payee,
        API_TOKEN: token,
        API_BASE: API,
        JSDOM_PATH,
        WAIT_FOR_DONE: '1',
        // Narrowed to this run's own statement: the dev database holds other
        // months, and a deck over all of them puts this row thirty cards deep.
        PAGE_URL: `http://localhost/bk/bank-matching?statement=${st.id}`,
      },
      encoding: 'utf8',
      // stderr PIPED, not inherited: execFileSync forwards a child's stderr to
      // the parent by default, which would print React Router's upgrade notices
      // straight past the filter below.
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    log = (err.stdout || '') + (err.stderr || '')
  }
  // React Router's own upgrade notices, which are not this page's business.
  log = log.split('\n').filter((l) => !/Future Flag Warning/.test(l)).join('\n')
  console.log(log.trim())

  // What actually landed, before it is removed. A harness that only checks the
  // request body would pass against a route that 200s and writes nothing.
  const { rows: [t2] } = await pool.query('SELECT matched_expense_id FROM bank_transactions WHERE id = $1', [tx.id])
  const eid = t2?.matched_expense_id
  let ledger = null
  if (eid) {
    const { rows: [e] } = await pool.query(
      `SELECT category, recoupable, recoup_reviewed, recoup_reviewed_by FROM expenses WHERE id = $1`, [eid])
    ledger = e
    console.log('LEDGER:', JSON.stringify(e))
    await pool.query('DELETE FROM bk_audit_log WHERE entry_id = $1', [eid]).catch(() => {})
    await pool.query('DELETE FROM expenses WHERE id = $1', [eid])
  } else {
    console.log('LEDGER: nothing booked')
  }
  await pool.query('DELETE FROM bank_transactions WHERE id = $1', [tx.id])
  await pool.query('DELETE FROM bank_statements WHERE id = $1', [st.id])
  await pool.query("DELETE FROM statement_payee_map WHERE bank_payee ILIKE 'DOMCHECK%'").catch(() => {})
  await pool.query("DELETE FROM statement_category_map WHERE bank_payee ILIKE 'DOMCHECK%'").catch(() => {})

  const failures = log.split('\n').filter((l) => /-> false/.test(l))
  // The answer has to be ON THE ROW, not just in the request.
  if (!ledger || ledger.recoup_reviewed !== true) {
    failures.push(`LEDGER: the entry was not left answered -> false (${JSON.stringify(ledger)})`)
  }
  out.push({ scenario, failures })
}

await pool.end()
const bad = out.filter((r) => r.failures.length)
console.log('\n' + '─'.repeat(60))
for (const r of out) console.log(`${r.failures.length ? 'FAIL' : 'ok  '}  ${r.scenario}`)
if (bad.length) {
  console.log('\nwhat failed:')
  for (const r of bad) for (const f of r.failures) console.log(`  ${r.scenario}: ${f.trim()}`)
}
process.exit(bad.length ? 1 : 0)
