/**
 * Remove the page header that older parses absorbed into transaction descriptors.
 *
 * BofA repeats an account header on every page:
 *
 *   <HOLDER> ! Account # 1234 5678 9012 ! March 1, 2026 to March 31, 2026
 *
 * The layout reconstruction emits it as ONE line, and because a record
 * accumulates every line until the next date-opening line, whichever record was
 * open at a page break swallowed it.
 *
 * Not cosmetic: the descriptor IS the payee for matching, the learned payee map,
 * vendor rollups and reversal pairing, so a bled row compares equal to nothing.
 * It is why one of two identical $5,000 card debits paired with its refund and
 * the other did not.
 *
 * The strip runs SERVER-side (POST /statements/repair-header-bleed) and accepts
 * no content from here — bank rows are evidence, and an endpoint that took
 * replacement text would make that evidence rewritable. This script only asks
 * for the dry run, shows it, and asks again for real.
 *
 * lib/statement-pdf.js now drops the line at parse time, so this is one-off
 * repair rather than an ongoing chore.
 *
 * Run:  node scripts/strip-statement-header-bleed.cjs scripts/.env [--go]
 */
const fs = require('fs');

const GO = process.argv.includes('--go');
const env = {};
fs.readFileSync(process.argv[2], 'utf8').split('\n').forEach((l) => {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
});
const BASE = (env.BOOM_API_URL || 'https://marketst-production.up.railway.app').replace(/\/+$/, '').replace(/\/api$/, '');

(async () => {
  console.log('deployed commit:', (await (await fetch(`${BASE}/health`)).json()).commit);
  const lj = await (await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.BOOM_EMAIL, password: env.BOOM_PASSWORD }),
  })).json();
  const token = lj.token || (lj.data && lj.data.token);
  if (!token) { console.error('login failed'); process.exit(1); }
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const call = async (dry) => (await (await fetch(`${BASE}/api/statements/repair-header-bleed`, {
    method: 'POST', headers: H, body: JSON.stringify({ dry }),
  })).json()).data;

  const plan = await call(true);
  console.log(`\nscanned ${plan.scanned} candidate row(s); ${plan.repaired} carry the header:`);
  for (const c of plan.changes) {
    console.log(`  tx${String(c.id).padEnd(6)}`);
    if (c.description) console.log(`     desc  -> ${c.description.slice(0, 78)}`);
    if (c.payee_guess) console.log(`     payee -> ${c.payee_guess.slice(0, 78)}`);
  }
  if (!plan.repaired) { console.log('\nnothing to do.'); return; }
  if (!GO) { console.log(`\n--dry: would clean ${plan.repaired} row(s)`); return; }

  const done = await call(false);
  console.log(`\nrepaired ${done.repaired} row(s)`);
  const left = await call(true);
  console.log(`still carrying the header: ${left.repaired}${left.repaired ? '  <- investigate' : ''}`);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
