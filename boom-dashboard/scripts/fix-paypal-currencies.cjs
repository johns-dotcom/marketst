/**
 * Correct the currency on PayPal bank_transactions, in place.
 *
 * The AI parse recorded every PayPal row as USD, while the statements name six to
 * ten currencies. Anything that converts those rows to USD has therefore been
 * treating EUR/GBP/AUD/JPY face values as dollars.
 *
 * Dry-runs every PayPal statement first and ABORTS before touching anything if a
 * statement reports unpaired or ambiguous rows — those are cases the pairing
 * couldn't prove, and guessing a currency is how you turn a reporting bug into a
 * data-corruption bug.
 *
 * Only the `currency` column changes. Amounts, matches, bookings, dismissals and
 * flags are untouched, so nothing needs re-reconciling afterwards.
 *
 * Run:  node scripts/fix-paypal-currencies.cjs scripts/.env [--go]
 */
const fs = require('fs');

const GO = process.argv.includes('--go');
const env = {};
fs.readFileSync(process.argv[2], 'utf8').split('\n').forEach((l) => {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
});
const BASE = (env.BOOM_API_URL || 'https://marketst-dashboard.up.railway.app').replace(/\/+$/, '').replace(/\/api$/, '');

(async () => {
  const health = await (await fetch(`${BASE}/health`)).json();
  console.log('deployed commit:', health.commit);

  const lj = await (await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.BOOM_EMAIL, password: env.BOOM_PASSWORD }),
  })).json();
  const token = lj.token || (lj.data && lj.data.token);
  if (!token) { console.error('login failed'); process.exit(1); }
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const stmts = ((await (await fetch(`${BASE}/api/statements`, { headers: H })).json()).data || [])
    .filter((s) => s.account === 'paypal' && s.status === 'ready')
    .sort((a, b) => String(a.period_start).localeCompare(String(b.period_start)));
  console.log(`PayPal statements: ${stmts.length}\n`);

  // ---- Dry run everything first -------------------------------------------
  const plans = [];
  let blocked = 0;
  for (const s of stmts) {
    const r = await fetch(`${BASE}/api/statements/${s.id}/fix-currencies?dry=1`, { method: 'POST', headers: H });
    const j = await r.json();
    if (!j.success) { console.log(`  id=${s.id} ${String(s.period_start).slice(0, 10)}  REFUSED — ${j.error}`); blocked++; continue; }
    const d = j.data;
    plans.push({ s, d });
    const flag = (d.unpaired || d.ambiguous) ? '  <-- UNPROVEN ROWS' : '';
    console.log(`  id=${String(s.id).padStart(3)} ${String(s.period_start).slice(0, 10)}`
      + `  rows ${String(d.app_rows).padStart(4)}  correct ${String(d.already_correct).padStart(4)}`
      + `  change ${String(d.to_change).padStart(4)}  unpaired ${d.unpaired}  ambiguous ${d.ambiguous}${flag}`);
    if (Object.keys(d.changes).length) console.log(`        ${Object.entries(d.changes).map(([k, v]) => `${v}x ${k}`).join('  ')}`);
  }

  const unproven = plans.filter((p) => p.d.unpaired || p.d.ambiguous);
  const total = plans.reduce((t, p) => t + p.d.to_change, 0);
  console.log(`\ntotal rows to correct: ${total}` + (blocked ? `   (${blocked} statement(s) refused)` : ''));
  if (unproven.length) {
    console.error(`\nABORTED: ${unproven.length} statement(s) contain rows the pairing could not prove `
      + `(${unproven.map((p) => `id=${p.s.id}: ${p.d.unpaired} unpaired / ${p.d.ambiguous} ambiguous`).join('; ')}).`);
    console.error('Nothing was changed. Guessing a currency would be worse than leaving it wrong.');
    process.exit(2);
  }
  if (!GO) { console.log('\nreport only — pass --go to apply'); return; }
  if (!total) { console.log('nothing to do'); return; }

  // ---- Apply --------------------------------------------------------------
  let changed = 0;
  for (const { s } of plans) {
    const r = await fetch(`${BASE}/api/statements/${s.id}/fix-currencies`, { method: 'POST', headers: H });
    const j = await r.json();
    if (!j.success) { console.log(`  id=${s.id} FAILED — ${j.error}`); continue; }
    changed += j.data.changed;
    console.log(`  id=${String(s.id).padStart(3)} corrected ${j.data.changed}`);
  }
  console.log(`\ncorrected ${changed} of ${total}`);

  // ---- Verify -------------------------------------------------------------
  const all = ((await (await fetch(`${BASE}/api/statements/all`, { headers: H })).json()).data?.transactions || []);
  for (const { s } of plans) {
    const rows = all.filter((t) => t.statement_id === s.id);
    const cur = {};
    rows.forEach((t) => { const k = String(t.currency || 'null').toUpperCase(); cur[k] = (cur[k] || 0) + 1; });
    console.log(`  id=${String(s.id).padStart(3)} now holds: ${Object.entries(cur).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }
  // The extras audit should stop reporting mismatches once the labels agree.
  const ex = (await (await fetch(`${BASE}/api/statements/extras`, { headers: H })).json()).data;
  console.log(`\nextras audit after: ${ex.total_extra} to review across ${ex.checked} checked statements`);
  ex.statements.filter((x) => x.account === 'paypal').forEach((x) => console.log(
    `  id=${String(x.id).padStart(3)} paypal  statement=${x.expected} app=${x.held} extra=${x.extraCount} missing=${x.missingCount}`));
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
