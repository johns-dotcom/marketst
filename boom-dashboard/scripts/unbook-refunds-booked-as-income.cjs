/**
 * Money coming back is not revenue.
 *
 * 11 bank credits whose own description says REVERSAL / REFUND were booked as
 * income ('created-income'), each creating an artist_income row — $9,419.16 of
 * revenue that is really a refund of spend. A refund reduces the expense it came
 * from; it never adds to the top line.
 *
 * Only 3 of the 11 raise a `reversal-booked-income` flag today, because that flag
 * also requires a pairable debit. The other 8 are the same defect with no alarm
 * on them, which is why this works from the data rather than from the flag list.
 *
 * The P&L already ignores the 8 that pair with their debit (lib/reversal-pairs.js
 * excludes both legs), so for those this is a ledger correction with no effect on
 * reported numbers. Three — Ticketmaster $17.45 and two Apple rows, $26.86 in
 * total — have no locatable original debit, so they are genuinely counted as
 * income today; unbooking moves them out of revenue and below the operating line
 * as unclassified money in, which is honest but still not netted against the
 * category they refund. Netting those needs the contra-expense treatment in the
 * GL design, not a data fix.
 *
 * `unbook-income` is the designed inverse of booking a credit as income: it
 * removes the created artist_income row and clears the link. Reversible.
 *
 * Aborts unless every row is a credit, booked via 'created-income', and actually
 * describes itself as a refund or reversal — no row is unbooked on amount alone.
 *
 * Run:  node scripts/unbook-refunds-booked-as-income.cjs scripts/.env [--go]
 */
const fs = require('fs');

const GO = process.argv.includes('--go');
const env = {};
fs.readFileSync(process.argv[2], 'utf8').split('\n').forEach((l) => {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
});
const BASE = (env.BOOM_API_URL || 'https://marketst-production.up.railway.app').replace(/\/+$/, '').replace(/\/api$/, '');
const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2 });

// Same predicate the shared lib uses, so this can't select a row the report
// would disagree about.
const { REVERSAL_RE } = require('../server/lib/reversal-pairs');

(async () => {
  console.log('deployed commit:', (await (await fetch(`${BASE}/health`)).json()).commit);
  const lj = await (await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.BOOM_EMAIL, password: env.BOOM_PASSWORD }),
  })).json();
  const token = lj.token || (lj.data && lj.data.token);
  if (!token) { console.error('login failed'); process.exit(1); }
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const txns = async () => ((await (await fetch(`${BASE}/api/statements/all`, { headers: H })).json()).data?.transactions || []);
  let all = await txns();

  const targets = all.filter((t) => t.direction === 'credit' && t.matched_income_id
    && REVERSAL_RE.test(t.description || ''));

  console.log(`\n${targets.length} refund/reversal credits booked as income:`);
  const problems = [];
  for (const t of targets) {
    console.log(`   tx${String(t.id).padEnd(6)}${String(t.txn_date).slice(0, 10)} ${money(t.amount).padStart(11)}`
      + `  income_id=${String(t.matched_income_id).padEnd(4)} | ${String(t.description || '').slice(0, 48)}`);
    if (t.match_method !== 'created-income') {
      problems.push(`tx${t.id} method is ${t.match_method}, not created-income — unbook-income would be wrong`);
    }
  }
  const total = targets.reduce((s, t) => s + Number(t.amount), 0);
  console.log(`   ${'total phantom income'.padEnd(28)}${money(total)}`);

  if (!targets.length) { console.log('\nnothing to do.'); return; }
  if (problems.length) {
    console.error('\nABORTED:\n  ' + problems.join('\n  ') + '\nNothing was modified.');
    process.exit(2);
  }
  if (!GO) { console.log(`\n--dry: would unbook all ${targets.length}, removing ${money(total)} of income`); return; }

  console.log();
  let ok = 0;
  for (const t of targets) {
    const r = await fetch(`${BASE}/api/statements/tx/${t.id}/unbook-income`, { method: 'POST', headers: H });
    if (r.ok) ok += 1;
    console.log(`unbook-income tx${String(t.id).padEnd(6)} -> ${r.status} ${JSON.stringify(await r.json().catch(() => ({}))).slice(0, 70)}`);
  }

  all = await txns();
  const left = all.filter((t) => t.direction === 'credit' && t.matched_income_id
    && REVERSAL_RE.test(t.description || ''));
  console.log(`\n${ok}/${targets.length} unbooked; ${left.length} refund credits still booked as income`
    + (left.length ? ' — investigate' : ''));
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
